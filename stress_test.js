const { Pool } = require('pg');
const fs = require('fs');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/krs_db'
});

async function runStressTest() {
  console.log('⚡ Memulai Stress Testing 1000 Data CSV ke PostgreSQL (Sistem Informasi)...');

  let fileData;
  try {
    fileData = fs.readFileSync('data_1000.csv', 'utf-8');
  } catch (err) {
    console.error('❌ File data_1000.csv tidak ditemukan. Jalankan node generate_csv.js dulu!');
    process.exit(1);
  }

  const lines = fileData.trim().split('\n').slice(1);
  const client = await pool.connect();

  // 1. Cek nilai ENUM valid untuk kolom role di tabel pengguna
  let validRole = null;
  try {
    const enumQuery = await client.query(`
      SELECT e.enumlabel 
      FROM pg_type t 
      JOIN pg_enum e ON t.oid = e.enumtypid 
      WHERE t.typname = 'role_pengguna' 
      LIMIT 1;
    `);
    if (enumQuery.rows.length > 0) {
      validRole = enumQuery.rows[0].enumlabel;
    }
  } catch (e) {}

  console.time('Waktu Eksekusi Stress Test');

  let successCount = 0;
  let firstErrorPrinted = false;

  for (const line of lines) {
    if (!line) continue;
    const [nim, nama, kode_mk, nama_mk, sks] = line.split(',').map(s => s.replace(/"/g, '').trim());

    try {
      let idPengguna;

      // 2. Insert ke tabel pengguna (kolom id, username, password_hash, role)
      if (validRole) {
        const resP = await client.query(
          `INSERT INTO pengguna (username, password_hash, role) 
           VALUES ($1, $2, $3) 
           ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username 
           RETURNING id`,
          [nim, 'hashed_password_123', validRole]
        );
        idPengguna = resP.rows[0].id;
      } else {
        const resP = await client.query(
          `INSERT INTO pengguna (username, password_hash) 
           VALUES ($1, $2) 
           ON CONFLICT (username) DO UPDATE SET username = EXCLUDED.username 
           RETURNING id`,
          [nim, 'hashed_password_123']
        );
        idPengguna = resP.rows[0].id;
      }

      // 3. Insert ke tabel mahasiswa (kolom nim, id_pengguna, nama, angkatan, semester)
      await client.query(
        `INSERT INTO mahasiswa (nim, nama, id_pengguna, angkatan, semester) 
         VALUES ($1, $2, $3, 2026, 5) 
         ON CONFLICT (nim) DO NOTHING`,
        [nim, nama, idPengguna]
      );

      // 4. Insert ke tabel mata_kuliah (opsional)
      try {
        await client.query(
          `INSERT INTO mata_kuliah (kode_mk, nama_mk, sks) 
           VALUES ($1, $2, $3) 
           ON CONFLICT (kode_mk) DO NOTHING`,
          [kode_mk, nama_mk, parseInt(sks)]
        );
      } catch (e) {}

      // 5. Insert ke tabel krs (opsional)
      try {
        await client.query(
          `INSERT INTO krs (nim, kode_mk) VALUES ($1, $2)`,
          [nim, kode_mk]
        );
      } catch (e) {}

      successCount++;
    } catch (err) {
      if (!firstErrorPrinted) {
        console.error('⚠️ Detail Error Pertama:', err.message);
        firstErrorPrinted = true;
      }
    }
  }

  console.log(`✅ Stress Test Selesai! Berhasil memproses ${successCount} data ke Database PostgreSQL!`);
  console.timeEnd('Waktu Eksekusi Stress Test');

  client.release();
  await pool.end();
}

runStressTest();