require('dotenv').config();
const express = require('express'), session = require('express-session'), bcrypt = require('bcryptjs'), { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const q = (s, p) => pool.query(s, p).then(r => r.rows);
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));
app.use(session({ secret: process.env.SESSION_SECRET || 'dev-secret', resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } }));

/* ---------- helpers ---------- */
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const H = h => ({ h });
const cell = c => (c && c.h !== undefined ? c.h : esc(c));
const table = (head, rows) => `<div class="tw"><table><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map(c => `<td>${cell(c)}</td>`).join('')}</tr>`).join('') || `<tr><td colspan="${head.length}" class="muted">Belum ada data</td></tr>`}</table></div>`;
const cards = a => `<div class="cards">${a.map(([l, v]) => `<div class="card"><small>${esc(l)}</small><b>${esc(v)}</b></div>`).join('')}</div>`;
const hid = (n, v) => `<input type="hidden" name="${n}" value="${esc(v)}">`;
const inp = (n, l, t = 'text', x = '') => `<label>${l}<input name="${n}" type="${t}" ${x}></label>`;
const sel = (n, l, opts, x = '') => `<label>${l}<select name="${n}" ${x}>${opts.map(([v, t]) => `<option value="${esc(v)}">${esc(t)}</option>`).join('')}</select></label>`;
const btn = (action, label, fields = '', cls = '') => `<form method="post" action="${action}" class="inline">${fields}<button class="${cls}">${label}</button></form>`;
const aktif = async () => (await q('select * from periode where is_aktif'))[0];

const NAV = {
  ADMIN: [['/', 'Dashboard'], ['/admin/pengguna', 'Data Pengguna'], ['/mahasiswa', 'Mahasiswa'], ['/dosen', 'Dosen'], ['/admin/mk', 'Mata Kuliah & Kuota'], ['/admin/periode', 'Periode KRS'], ['/laporan', 'Laporan']],
  KAPRODI: [['/', 'Dashboard'], ['/mahasiswa', 'Mahasiswa'], ['/dosen', 'Dosen'], ['/laporan', 'Laporan']],
  DOSEN_WALI: [['/', 'Dashboard'], ['/bimbingan', 'Validasi KRS']],
  MAHASISWA: [['/', 'Dashboard'], ['/katalog', 'Katalog MK'], ['/krs', 'Keranjang KRS'], ['/status', 'Status & Riwayat'], ['/cetak', 'Cetak KRS']]
};
const page = (req, title, body) => {
  const u = req.session.user, f = req.session.flash; delete req.session.flash;
  return `<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} · SIKRS</title><link rel="stylesheet" href="/style.css"></head><body class="${u ? 'app' : 'auth'}">
${u ? `<aside><h1>🌸 SIKRS</h1><nav>${NAV[u.role].map(([h, l]) => `<a href="${h}">${l}</a>`).join('')}</nav><form method="post" action="/logout"><small>${esc(u.nama)}<br>${u.role}</small><button class="ghost">Keluar</button></form></aside>` : ''}
<main>${f ? `<div class="flash ${f.ok ? 'ok' : 'err'}">${esc(f.m)}</div>` : ''}<h2>${esc(title)}</h2>${body}</main></body></html>`;
};
const need = (...roles) => (req, res, next) => {
  const u = req.session.user;
  if (!u) return res.redirect('/login');
  if (roles.length && !roles.includes(u.role)) return res.status(403).send(page(req, 'Akses ditolak', '<p>Anda tidak berhak membuka halaman ini.</p>'));
  next();
};
const w = fn => (req, res, next) => fn(req, res, next).catch(next);
// aksi POST: tampilkan pesan hasil (atau pesan aturan bisnis BR-xx dari trigger) lalu kembali
const act = fn => async (req, res) => {
  try { req.session.flash = { m: (await fn(req, res)) || 'Berhasil disimpan', ok: 1 }; }
  catch (e) { req.session.flash = { m: e.code === '23505' ? 'Data sudah ada / duplikat (BR-02 jika kelas ganda)' : e.message }; }
  res.redirect(req.get('referer') || '/');
};
const ensureKrs = async nim => {
  const p = await aktif(); if (!p) throw new Error('Tidak ada periode KRS aktif');
  await q('insert into krs(nim,id_periode) values($1,$2) on conflict do nothing', [nim, p.id_periode]);
  return (await q('select * from krs where nim=$1 and id_periode=$2', [nim, p.id_periode]))[0];
};

/* ---------- login ---------- */
app.get('/login', (req, res) => res.send(page(req, 'Masuk', `<form method="post" class="panel narrow">${inp('username', 'NIM / NIDN / Username', 'text', 'required autofocus')}${inp('password', 'Password', 'password', 'required')}<button>Masuk</button></form><p class="muted">Akun dibuat oleh Admin.</p>`)));
app.post('/login', w(async (req, res) => {
  const [p] = await q(`select p.*, m.nim, m.nama mn, d.id_dosen, d.nama dn from pengguna p left join mahasiswa m on m.id_pengguna=p.id left join dosen d on d.id_pengguna=p.id where p.username=$1 and p.aktif`, [req.body.username]);
  if (!p || !(await bcrypt.compare(req.body.password, p.password_hash))) { req.session.flash = { m: 'Username atau password salah' }; return res.redirect('/login'); }
  req.session.regenerate(() => { req.session.user = { id: p.id, role: p.role, nim: p.nim, idDosen: p.id_dosen, nama: p.mn || p.dn || p.username }; res.redirect('/'); });
}));
app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

/* ---------- dashboard ---------- */
app.get('/', need(), w(async (req, res) => {
  const u = req.session.user, p = await aktif(); let b = '';
  const pa = `<p class="muted">Periode aktif: <b>${esc(p ? p.nama : 'belum ada')}</b></p>`;
  if (u.role === 'ADMIN') { const [s] = await q('select * from v_stat_admin'); b = cards([['Mahasiswa', s.jml_mahasiswa], ['Dosen', s.jml_dosen], ['Mata Kuliah', s.jml_mk], ['Periode Aktif', s.periode_aktif || '-']]); }
  else if (u.role === 'KAPRODI') { const [s] = p ? await q('select * from v_laporan_status_krs where id_periode=$1', [p.id_periode]) : []; b = cards([['Draft', s?.draft ?? 0], ['Diajukan', s?.diajukan ?? 0], ['Disetujui', s?.disetujui ?? 0], ['Total KRS', s?.total ?? 0]]); }
  else if (u.role === 'DOSEN_WALI') { const [{ n }] = await q('select count(*) n from v_pengajuan_bimbingan where id_dosen_wali=$1', [u.idDosen]); const [{ t }] = await q('select count(*) t from mahasiswa where id_dosen_wali=$1', [u.idDosen]); b = cards([['Mahasiswa Bimbingan', t], ['Menunggu Persetujuan', n]]); }
  else {
    const [m] = await q('select * from v_daftar_mahasiswa where nim=$1', [u.nim]);
    const [k] = p ? await q('select * from v_status_krs where nim=$1 and id_periode=$2', [u.nim, p.id_periode]) : [];
    b = cards([['IPK', m.ipk], ['Batas SKS', `${m.sks_min}–${m.sks_maks}`], ['SKS di KRS', k ? k.total_sks : 0], ['Status KRS', k ? k.status : 'Belum dibuat']]) + (k && k.catatan_revisi ? `<div class="flash err">Catatan dosen wali: ${esc(k.catatan_revisi)}</div>` : '');
  }
  res.send(page(req, `Halo, ${u.nama}`, pa + b));
}));

/* ---------- ADMIN: pengguna ---------- */
app.get('/admin/pengguna', need('ADMIN'), w(async (req, res) => {
  const dsn = await q(`select id_dosen, nama from dosen order by nama`);
  const us = await q(`select p.id, p.username, p.role, coalesce(m.nama,d.nama,'-') nama from pengguna p left join mahasiswa m on m.id_pengguna=p.id left join dosen d on d.id_pengguna=p.id order by p.role, p.username`);
  const form = `<form method="post" action="/admin/pengguna" class="panel grid">
${sel('role', 'Role', ['MAHASISWA', 'DOSEN_WALI', 'KAPRODI', 'ADMIN'].map(r => [r, r]))}${inp('username', 'NIM / NIDN / Username', 'text', 'required')}${inp('password', 'Password awal', 'password', 'required minlength=6')}${inp('nama', 'Nama lengkap', 'text', 'required')}
${inp('angkatan', 'Angkatan (mhs)', 'number')}${inp('semester', 'Semester (mhs)', 'number', 'value=1')}${inp('ipk', 'IPK (mhs)', 'number', 'step=0.01 min=0 max=4 value=0')}
${sel('dosen_wali', 'Dosen wali (mhs)', [['', '— belum ada —'], ...dsn.map(d => [d.id_dosen, d.nama])])}<button>Tambah Pengguna</button></form>`;
  res.send(page(req, 'Manajemen Data Pengguna', form + table(['Username', 'Nama', 'Role', ''], us.map(u => [u.username, u.nama, u.role, H(btn('/admin/pengguna/hapus', 'Hapus', hid('id', u.id), 'danger'))]))));
}));
app.post('/admin/pengguna', need('ADMIN'), act(async req => {
  const b = req.body, c = await pool.connect();
  try {
    await c.query('begin');
    const { rows: [p] } = await c.query('insert into pengguna(username,password_hash,role) values($1,$2,$3) returning id', [b.username, await bcrypt.hash(b.password, 10), b.role]);
    if (b.role === 'MAHASISWA') await c.query('insert into mahasiswa(nim,id_pengguna,nama,angkatan,semester,ipk,ips_terakhir,id_dosen_wali) values($1,$2,$3,$4,$5,$6,$6,$7)', [b.username, p.id, b.nama, b.angkatan || null, b.semester || 1, b.ipk || 0, b.dosen_wali || null]);
    else if (b.role !== 'ADMIN') await c.query('insert into dosen(id_dosen,id_pengguna,nama,jabatan) values($1,$2,$3,$4)', [b.username, p.id, b.nama, b.role]);
    await c.query('commit'); return 'Pengguna ditambahkan';
  } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
}));
app.post('/admin/pengguna/hapus', need('ADMIN'), act(async req => { if (+req.body.id === req.session.user.id) throw new Error('Tidak bisa menghapus akun sendiri'); await q('delete from pengguna where id=$1', [req.body.id]); return 'Pengguna dihapus'; }));

/* ---------- daftar mahasiswa & dosen (kaprodi/admin) ---------- */
app.get('/mahasiswa', need('ADMIN', 'KAPRODI'), w(async (req, res) => {
  const s = `%${req.query.q || ''}%`, adm = req.session.user.role === 'ADMIN';
  const r = await q('select * from v_daftar_mahasiswa where nim ilike $1 or nama ilike $1 order by nim', [s]);
  const head = ['NIM', 'Nama', 'Angkatan', 'Smt', 'IPK', 'IPS', 'Batas SKS', 'Dosen Wali'].concat(adm ? ['Ubah nilai'] : []);
  res.send(page(req, 'Daftar Mahasiswa', `<form class="panel inline"><input name="q" placeholder="Cari NIM / nama" value="${esc(req.query.q || '')}"><button>Cari</button></form>` +
    table(head, r.map(m => [m.nim, m.nama, m.angkatan, m.semester, m.ipk, m.ips_terakhir, `${m.sks_min}–${m.sks_maks}`, m.dosen_wali || '-'].concat(adm ? [H(btn('/admin/mhs/nilai', 'Simpan', hid('nim', m.nim) + `<input name="ipk" type="number" step="0.01" min="0" max="4" value="${m.ipk}" class="sm"><input name="ips" type="number" step="0.01" min="0" max="4" value="${m.ips_terakhir}" class="sm"><input name="semester" type="number" value="${m.semester}" class="sm">`))] : [])))));
}));
app.post('/admin/mhs/nilai', need('ADMIN'), act(async req => { await q('update mahasiswa set ipk=$2, ips_terakhir=$3, semester=$4 where nim=$1', [req.body.nim, req.body.ipk, req.body.ips, req.body.semester]); return 'Data mahasiswa diperbarui'; }));
app.get('/dosen', need('ADMIN', 'KAPRODI'), w(async (req, res) => {
  const r = await q('select d.id_dosen, d.nama, d.jabatan, (select count(*) from mahasiswa m where m.id_dosen_wali=d.id_dosen) n from dosen d order by d.nama');
  res.send(page(req, 'Daftar Dosen', table(['NIDN', 'Nama', 'Jabatan', 'Jumlah Bimbingan'], r.map(d => [d.id_dosen, d.nama, d.jabatan, d.n]))));
}));

/* ---------- ADMIN: mata kuliah, kelas & kuota ---------- */
app.get('/admin/mk', need('ADMIN'), w(async (req, res) => {
  const p = await aktif(), mk = await q('select * from mata_kuliah order by kode_mk'), dsn = await q('select id_dosen, nama from dosen order by nama');
  const kl = p ? await q('select * from v_katalog_kelas where id_periode=$1 order by nama_mk, nama_kelas', [p.id_periode]) : [];
  const f1 = `<form method="post" action="/admin/mk" class="panel grid">${inp('kode_mk', 'Kode MK', 'text', 'required')}${inp('nama_mk', 'Nama MK', 'text', 'required')}${inp('sks', 'SKS', 'number', 'min=1 max=6 required')}${inp('semester', 'Semester', 'number')}<button>Tambah Mata Kuliah</button></form>`;
  const f2 = p ? `<form method="post" action="/admin/kelas" class="panel grid">${sel('kode_mk', 'Mata kuliah', mk.map(m => [m.kode_mk, `${m.kode_mk} – ${m.nama_mk}`]))}${inp('nama_kelas', 'Kelas (A/B/…)', 'text', 'required')}${inp('kuota', 'Kuota', 'number', 'min=0 required')}${sel('dosen', 'Dosen pengampu', [['', '—'], ...dsn.map(d => [d.id_dosen, d.nama])])}${inp('hari', 'Hari')}${inp('jam_mulai', 'Mulai', 'time')}${inp('jam_selesai', 'Selesai', 'time')}${inp('ruang', 'Ruang')}<button>Buat Kelas (${esc(p.id_periode)})</button></form>` : '<p class="flash err">Aktifkan periode dulu untuk membuat kelas.</p>';
  res.send(page(req, 'Mata Kuliah & Kuota', f1 + table(['Kode', 'Nama', 'SKS'], mk.map(m => [m.kode_mk, m.nama_mk, m.sks])) + '<h3>Kelas periode aktif</h3>' + f2 +
    table(['MK', 'Kelas', 'Terisi', 'Kuota'], kl.map(k => [k.nama_mk, k.nama_kelas, k.terisi, H(btn('/admin/kelas/kuota', 'Ubah', hid('id', k.id_kelas) + `<input name="kuota" type="number" min="0" value="${k.kuota}" class="sm">`))]))));
}));
app.post('/admin/mk', need('ADMIN'), act(async req => { const b = req.body; await q('insert into mata_kuliah(kode_mk,nama_mk,sks,semester) values($1,$2,$3,$4)', [b.kode_mk, b.nama_mk, b.sks, b.semester || null]); return 'Mata kuliah ditambahkan'; }));
app.post('/admin/kelas', need('ADMIN'), act(async req => { const b = req.body, p = await aktif(); await q('insert into kelas(kode_mk,id_periode,nama_kelas,kuota,id_dosen_pengampu,hari,jam_mulai,jam_selesai,ruang) values($1,$2,$3,$4,$5,$6,$7,$8,$9)', [b.kode_mk, p.id_periode, b.nama_kelas, b.kuota, b.dosen || null, b.hari || null, b.jam_mulai || null, b.jam_selesai || null, b.ruang || null]); return 'Kelas dibuat'; }));
app.post('/admin/kelas/kuota', need('ADMIN'), act(async req => { await q('update kelas set kuota=$2 where id=$1', [req.body.id, req.body.kuota]); return 'Kuota diperbarui'; }));

/* ---------- ADMIN: periode ---------- */
app.get('/admin/periode', need('ADMIN'), w(async (req, res) => {
  const r = await q('select * from periode order by tgl_mulai desc');
  const f = `<form method="post" action="/admin/periode" class="panel grid">${inp('id_periode', 'ID (mis. 2027-GENAP)', 'text', 'required')}${inp('nama', 'Nama periode', 'text', 'required')}${inp('tgl_mulai', 'Mulai', 'date', 'required')}${inp('tgl_selesai', 'Selesai', 'date', 'required')}<button>Tambah Periode</button></form>`;
  res.send(page(req, 'Pengaturan Periode KRS', f + table(['ID', 'Nama', 'Mulai', 'Selesai', 'Status'], r.map(p => [p.id_periode, p.nama, String(p.tgl_mulai).slice(4, 15), String(p.tgl_selesai).slice(4, 15), H(p.is_aktif ? '<span class="pill">AKTIF</span>' : btn('/admin/periode/aktif', 'Aktifkan', hid('id', p.id_periode)))]))));
}));
app.post('/admin/periode', need('ADMIN'), act(async req => { const b = req.body; await q('insert into periode(id_periode,nama,tgl_mulai,tgl_selesai) values($1,$2,$3,$4)', [b.id_periode, b.nama, b.tgl_mulai, b.tgl_selesai]); return 'Periode ditambahkan'; }));
app.post('/admin/periode/aktif', need('ADMIN'), act(async req => { const c = await pool.connect(); try { await c.query('begin'); await c.query('update periode set is_aktif=false where is_aktif'); await c.query('update periode set is_aktif=true where id_periode=$1', [req.body.id]); await c.query('commit'); } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); } return 'Periode diaktifkan'; }));

/* ---------- MAHASISWA ---------- */
app.get('/katalog', need('MAHASISWA'), w(async (req, res) => {
  const p = await aktif(); if (!p) return res.send(page(req, 'Katalog Mata Kuliah', '<p class="flash err">Belum ada periode aktif.</p>'));
  const r = await q('select * from v_katalog_kelas where id_periode=$1 and (nama_mk ilike $2 or kode_mk ilike $2) order by nama_mk, nama_kelas', [p.id_periode, `%${req.query.q || ''}%`]);
  const jam = k => `${k.hari || '-'} ${k.jam_mulai ? String(k.jam_mulai).slice(0, 5) : ''}`;
  res.send(page(req, 'Katalog & Pencarian Mata Kuliah', `<form class="panel inline"><input name="q" placeholder="Cari kode / nama MK" value="${esc(req.query.q || '')}"><button>Cari</button></form>` +
    table(['Kode', 'Mata Kuliah', 'SKS', 'Kelas', 'Dosen', 'Jadwal', 'Sisa/Kuota', ''], r.map(k => [k.kode_mk, k.nama_mk, k.sks, k.nama_kelas, k.dosen_pengampu || '-', jam(k), `${k.sisa_kuota}/${k.kuota}`, H(k.sisa_kuota > 0 ? btn('/krs/tambah', '+ KRS', hid('id_kelas', k.id_kelas)) : '<span class="pill off">Penuh</span>')]))));
}));
app.post('/krs/tambah', need('MAHASISWA'), act(async req => { const k = await ensureKrs(req.session.user.nim); await q('insert into krs_kelas(id_krs,id_kelas) values($1,$2)', [k.id, req.body.id_kelas]); return 'Kelas ditambahkan ke KRS'; }));
app.post('/krs/hapus', need('MAHASISWA'), act(async req => { const k = await ensureKrs(req.session.user.nim); await q('delete from krs_kelas where id_krs=$1 and id_kelas=$2', [k.id, req.body.id_kelas]); return 'Kelas dihapus dari KRS'; }));
app.post('/krs/ajukan', need('MAHASISWA'), act(async req => { const k = await ensureKrs(req.session.user.nim); await q(`update krs set status='DIAJUKAN' where id=$1`, [k.id]); return 'KRS berhasil diajukan ke dosen wali'; }));
app.get('/krs', need('MAHASISWA'), w(async (req, res) => {
  const u = req.session.user, p = await aktif(); if (!p) return res.send(page(req, 'Keranjang KRS', '<p class="flash err">Belum ada periode aktif.</p>'));
  const k = await ensureKrs(u.nim), [m] = await q('select * from v_daftar_mahasiswa where nim=$1', [u.nim]);
  const it = await q('select i.*, kk.id_kelas from v_isi_krs i join krs_kelas kk on kk.id_krs=i.id_krs join kelas kl on kl.id=kk.id_kelas and kl.kode_mk=i.kode_mk and kl.nama_kelas=i.nama_kelas where i.id_krs=$1 order by i.nama_mk', [k.id]);
  const total = it.reduce((a, b) => a + b.sks, 0), d = k.status === 'DRAFT';
  res.send(page(req, 'Keranjang KRS', cards([['Periode', p.id_periode], ['Status', k.status], ['Total SKS', total], ['Batas SKS (IPK ' + m.ipk + ')', `${m.sks_min}–${m.sks_maks}`]]) + (k.catatan_revisi ? `<div class="flash err">Revisi dosen wali: ${esc(k.catatan_revisi)}</div>` : '') +
    table(['Kode', 'Mata Kuliah', 'Kelas', 'SKS', ''], it.map(i => [i.kode_mk, i.nama_mk, i.nama_kelas, i.sks, H(d ? btn('/krs/hapus', 'Hapus', hid('id_kelas', i.id_kelas), 'danger') : '')])) +
    (d ? `<p><a class="button" href="/katalog">+ Tambah dari katalog</a> ${btn('/krs/ajukan', 'Ajukan KRS')}</p>` : '<p class="muted">KRS terkunci karena sudah diajukan/disetujui.</p>')));
}));
app.get('/status', need('MAHASISWA'), w(async (req, res) => {
  const n = req.session.user.nim, s = await q('select * from v_status_krs where nim=$1 order by id_periode desc', [n]);
  const h = await q('select r.*, k.id_periode from krs_riwayat r join krs k on k.id=r.id_krs where k.nim=$1 order by r.waktu desc', [n]);
  res.send(page(req, 'Status & Riwayat KRS', table(['Periode', 'Status', 'Total SKS', 'Catatan'], s.map(x => [x.id_periode, x.status, x.total_sks, x.catatan_revisi || '-'])) + '<h3>Riwayat perubahan</h3>' + table(['Waktu', 'Periode', 'Dari', 'Ke', 'Catatan'], h.map(x => [new Date(x.waktu).toLocaleString('id-ID'), x.id_periode, x.status_lama, x.status_baru, x.catatan || '-']))));
}));
app.get('/cetak', need('MAHASISWA'), w(async (req, res) => {
  const u = req.session.user, p = await aktif(); const it = p ? await q(`select * from v_isi_krs where nim=$1 and id_periode=$2 and status='DISETUJUI' order by nama_mk`, [u.nim, p.id_periode]) : [];
  if (!it.length) return res.send(page(req, 'Cetak KRS', '<p class="flash err">KRS belum disetujui dosen wali, belum bisa dicetak.</p>'));
  res.send(page(req, 'Kartu Rencana Studi', `<p>${esc(u.nama)} (${esc(u.nim)}) · Periode ${esc(p.nama)}</p>` + table(['Kode', 'Mata Kuliah', 'Kelas', 'SKS', 'Jadwal'], it.map(i => [i.kode_mk, i.nama_mk, i.nama_kelas, i.sks, `${i.hari || '-'} ${i.jam_mulai ? String(i.jam_mulai).slice(0, 5) : ''}`])) + `<p><b>Total SKS: ${it.reduce((a, b) => a + b.sks, 0)}</b></p><button onclick="window.print()" class="noprint">🖨 Cetak</button>`));
}));

/* ---------- DOSEN WALI ---------- */
app.get('/bimbingan', need('DOSEN_WALI'), w(async (req, res) => {
  const r = await q(`select v.*, (select string_agg(i.nama_mk||' ('||i.sks||' SKS)', ', ') from v_isi_krs i where i.nim=v.nim and i.id_periode=v.id_periode) mk from v_pengajuan_bimbingan v where v.id_dosen_wali=$1 order by v.diajukan_pada`, [req.session.user.idDosen]);
  const all = await q(`select m.nim, m.nama, m.ipk, coalesce(k.status::text,'Belum ada KRS') st from mahasiswa m left join krs k on k.nim=m.nim and k.id_periode=(select id_periode from periode where is_aktif) where m.id_dosen_wali=$1 order by m.nim`, [req.session.user.idDosen]);
  const row = x => [x.nim, x.nama, x.ipk, `${x.total_sks} SKS`, x.mk || '-', H(`<form method="post" action="/bimbingan/tolak" class="inline">${hid('nim', x.nim)}${hid('periode', x.id_periode)}<input name="catatan" placeholder="Catatan revisi" required><button class="danger">Tolak</button></form>` + btn('/bimbingan/setuju', 'ACC', hid('nim', x.nim) + hid('periode', x.id_periode)))];
  res.send(page(req, 'Validasi KRS Mahasiswa Bimbingan', '<h3>Menunggu persetujuan</h3>' + table(['NIM', 'Nama', 'IPK', 'Total', 'Mata kuliah', 'Aksi'], r.map(row)) + '<h3>Seluruh mahasiswa bimbingan</h3>' + table(['NIM', 'Nama', 'IPK', 'Status KRS'], all.map(a => [a.nim, a.nama, a.ipk, a.st]))));
}));
app.post('/bimbingan/setuju', need('DOSEN_WALI'), act(async req => { await q('select fn_setujui_krs($1,$2,$3)', [req.session.user.idDosen, req.body.nim, req.body.periode]); return 'KRS disetujui'; }));
app.post('/bimbingan/tolak', need('DOSEN_WALI'), act(async req => { await q('select fn_tolak_krs($1,$2,$3,$4)', [req.session.user.idDosen, req.body.nim, req.body.periode, req.body.catatan]); return 'KRS dikembalikan ke mahasiswa untuk revisi'; }));

/* ---------- LAPORAN KAPRODI ---------- */
app.get('/laporan', need('ADMIN', 'KAPRODI'), w(async (req, res) => {
  const s = await q('select * from v_laporan_status_krs order by id_periode desc'), p = await aktif();
  const k = p ? await q('select * from v_laporan_kelas where id_periode=$1 order by persen_terisi desc nulls last', [p.id_periode]) : [];
  res.send(page(req, 'Laporan Program Studi', '<h3>Rekap status KRS per periode</h3>' + table(['Periode', 'Draft', 'Diajukan', 'Disetujui', 'Total'], s.map(x => [x.id_periode, x.draft, x.diajukan, x.disetujui, x.total])) +
    '<h3>Keterisian kelas (periode aktif)</h3>' + table(['MK', 'Kelas', 'Terisi', 'Kuota', '% Terisi'], k.map(x => [x.nama_mk, x.nama_kelas, x.terisi, x.kuota, H(`<div class="bar"><i style="width:${Math.min(100, x.persen_terisi || 0)}%"></i></div> ${x.persen_terisi ?? 0}%`)]))));
}));

app.use((e, req, res, next) => { console.error(e); res.status(500).send(page(req, 'Terjadi kesalahan', `<p>${esc(e.message)}</p>`)); });
app.listen(process.env.PORT || 3000, () => console.log('SIKRS berjalan di http://localhost:' + (process.env.PORT || 3000)));
