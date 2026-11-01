require('dotenv').config();
const { Pool } = require('pg'), bcrypt = require('bcryptjs');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const user = async (u, pw, role) => (await pool.query('insert into pengguna(username,password_hash,role) values($1,$2,$3) on conflict(username) do update set role=$3 returning id', [u, await bcrypt.hash(pw, 10), role])).rows[0].id;
(async () => {
  await user('admin', 'admin123', 'ADMIN');
  for (const [id, n, pw, role] of [['D001', 'Dr. Ratna Dewi (Kaprodi)', 'kaprodi123', 'KAPRODI'], ['D002', 'Budi Santoso, M.Kom', 'dosen123', 'DOSEN_WALI']])
    await pool.query('insert into dosen(id_dosen,id_pengguna,nama,jabatan) values($1,$2,$3,$4) on conflict do nothing', [id, await user(id, pw, role), n, role]);
  for (const [nim, n, ipk] of [['M001', 'Siti Aulia', 3.2], ['M002', 'Rina Putri', 2.1]])
    await pool.query('insert into mahasiswa(nim,id_pengguna,nama,angkatan,semester,ipk,ips_terakhir,id_dosen_wali) values($1,$2,$3,2024,3,$4,$4,$5) on conflict do nothing', [nim, await user(nim, 'mhs123', 'MAHASISWA'), n, ipk, 'D002']);
  await pool.query(`insert into periode(id_periode,nama,tgl_mulai,tgl_selesai,is_aktif) values('2026-GANJIL','Semester Ganjil 2026/2027','2026-08-01','2026-12-31',true) on conflict do nothing`);
  const mk = [['IF101', 'Algoritma & Pemrograman', 3], ['IF102', 'Basis Data', 3], ['IF103', 'Jaringan Komputer', 3], ['IF104', 'Rekayasa Perangkat Lunak', 3], ['IF105', 'Statistika', 2], ['IF106', 'Pemrograman Web', 3], ['IF107', 'Sistem Operasi', 3]];
  for (const [k, n, s] of mk) {
    await pool.query('insert into mata_kuliah(kode_mk,nama_mk,sks) values($1,$2,$3) on conflict do nothing', [k, n, s]);
    for (const c of ['A', 'B']) await pool.query(`insert into kelas(kode_mk,id_periode,nama_kelas,kuota,id_dosen_pengampu,hari,jam_mulai,jam_selesai,ruang) values($1,'2026-GANJIL',$2,30,'D002','Senin','08:00','10:30','R101') on conflict do nothing`, [k, c]);
  }
  console.log('Seed selesai. Login: admin/admin123, D001/kaprodi123, D002/dosen123, M001/mhs123'); await pool.end();
})();
