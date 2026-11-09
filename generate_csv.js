const fs = require('fs');

const namaDepan = ['Budi', 'Siti', 'Ahmad', 'Rizky', 'Dewi', 'Andi', 'Nia', 'Fajar', 'Dina', 'Eko'];
const namaBelakang = ['Santoso', 'Pratama', 'Wibowo', 'Putri', 'Hidayat', 'Lestari', 'Kusuma', 'Saputra'];
const matkulList = [
  { kode: 'IF101', nama: 'Pemrograman Web', sks: 3 },
  { kode: 'IF102', nama: 'Basis Data', sks: 4 },
  { kode: 'IF103', nama: 'Struktur Data', sks: 3 },
  { kode: 'IF104', nama: 'Jaringan Komputer', sks: 3 },
  { kode: 'IF105', nama: 'Sistem Operasi', sks: 3 }
];

function getRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

let csvContent = "nim,nama,kode_mk,nama_mk,sks\n";

for (let i = 1; i <= 1000; i++) {
  const nim = `2026${String(i).padStart(4, '0')}`;
  const nama = `${getRandom(namaDepan)} ${getRandom(namaBelakang)}`;
  const mk = getRandom(matkulList);
  csvContent += `${nim},"${nama}",${mk.kode},"${mk.nama}",${mk.sks}\n`;
}

fs.writeFileSync('data_1000.csv', csvContent);
console.log('✅ Berhasil generate 1000 data di data_1000.csv');