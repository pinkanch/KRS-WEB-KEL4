-- =====================================================================
-- SISTEM KRS - PostgreSQL 13+
-- Role: ADMIN, DOSEN_WALI, KAPRODI, MAHASISWA
-- Aturan bisnis (dari diagram):
--  BR-01 KRS hanya dapat diubah saat status DRAFT
--  BR-02 Kelas tidak boleh duplikat dalam satu KRS
--  BR-03 Kuota kelas tidak boleh terlampaui
--  BR-04 Total SKS tidak boleh melebihi batas (berdasarkan IPK)
--  BR-05 Kelas harus berasal dari periode yang sama dengan KRS
--  BR-06 KRS kosong / di bawah SKS minimal tidak boleh diajukan
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------- ENUM ----------
CREATE TYPE role_pengguna AS ENUM ('ADMIN', 'DOSEN_WALI', 'KAPRODI', 'MAHASISWA');
CREATE TYPE status_krs    AS ENUM ('DRAFT', 'DIAJUKAN', 'DISETUJUI');

-- ---------- PENGGUNA (Login & Register oleh Admin) ----------
CREATE TABLE pengguna (
    id             BIGSERIAL PRIMARY KEY,
    username       VARCHAR(50)  NOT NULL UNIQUE,   -- NIM / NIDN / username admin
    password_hash  TEXT         NOT NULL,          -- simpan hash bcrypt dari aplikasi
    role           role_pengguna NOT NULL,
    aktif          BOOLEAN      NOT NULL DEFAULT TRUE,
    dibuat_pada    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- ---------- DOSEN (Dosen Wali & Kaprodi) ----------
CREATE TABLE dosen (
    id_dosen     VARCHAR(20) PRIMARY KEY,          -- NIDN
    id_pengguna  BIGINT      NOT NULL UNIQUE REFERENCES pengguna(id) ON DELETE CASCADE,
    nama         VARCHAR(100) NOT NULL,
    email        VARCHAR(100) UNIQUE,
    jabatan      VARCHAR(20)  NOT NULL DEFAULT 'DOSEN_WALI'
                 CHECK (jabatan IN ('DOSEN_WALI', 'KAPRODI'))
);

-- ---------- MAHASISWA ----------
CREATE TABLE mahasiswa (
    nim             VARCHAR(20) PRIMARY KEY,
    id_pengguna     BIGINT      NOT NULL UNIQUE REFERENCES pengguna(id) ON DELETE CASCADE,
    nama            VARCHAR(100) NOT NULL,
    angkatan        SMALLINT,
    semester        SMALLINT    NOT NULL DEFAULT 1,
    ipk             NUMERIC(3,2) NOT NULL DEFAULT 0.00 CHECK (ipk BETWEEN 0 AND 4),
    ips_terakhir    NUMERIC(3,2) NOT NULL DEFAULT 0.00 CHECK (ips_terakhir BETWEEN 0 AND 4),
    id_dosen_wali   VARCHAR(20) REFERENCES dosen(id_dosen) ON DELETE SET NULL
);
CREATE INDEX idx_mhs_dosen_wali ON mahasiswa(id_dosen_wali);

-- ---------- MATA KULIAH ----------
CREATE TABLE mata_kuliah (
    kode_mk   VARCHAR(20) PRIMARY KEY,
    nama_mk   VARCHAR(150) NOT NULL,
    sks       SMALLINT     NOT NULL CHECK (sks BETWEEN 1 AND 6),
    semester  SMALLINT,
    aktif     BOOLEAN      NOT NULL DEFAULT TRUE
);

-- ---------- PERIODE KRS (Pengaturan oleh Admin) ----------
CREATE TABLE periode (
    id_periode   VARCHAR(10) PRIMARY KEY,          -- contoh: 2026-GANJIL
    nama         VARCHAR(100) NOT NULL,
    tgl_mulai    DATE NOT NULL,
    tgl_selesai  DATE NOT NULL,
    is_aktif     BOOLEAN NOT NULL DEFAULT FALSE,
    CHECK (tgl_selesai >= tgl_mulai)
);
-- hanya boleh ada satu periode aktif
CREATE UNIQUE INDEX uq_periode_aktif ON periode (is_aktif) WHERE is_aktif;

-- ---------- KELAS (Mata kuliah per periode + kuota) ----------
CREATE TABLE kelas (
    id          BIGSERIAL PRIMARY KEY,
    kode_mk     VARCHAR(20) NOT NULL REFERENCES mata_kuliah(kode_mk) ON DELETE RESTRICT,
    id_periode  VARCHAR(10) NOT NULL REFERENCES periode(id_periode) ON DELETE RESTRICT,
    nama_kelas  VARCHAR(20) NOT NULL,              -- A, B, C (kelas paralel)
    kuota       INTEGER     NOT NULL CHECK (kuota >= 0),
    id_dosen_pengampu VARCHAR(20) REFERENCES dosen(id_dosen) ON DELETE SET NULL,
    hari        VARCHAR(10),
    jam_mulai   TIME,
    jam_selesai TIME,
    ruang       VARCHAR(30),
    UNIQUE (kode_mk, id_periode, nama_kelas)
);
CREATE INDEX idx_kelas_periode ON kelas(id_periode);

-- ---------- KEBIJAKAN SKS (min/maks tergantung IPK) ----------
CREATE TABLE kebijakan_sks (
    id        SERIAL PRIMARY KEY,
    ipk_min   NUMERIC(3,2) NOT NULL,
    ipk_maks  NUMERIC(3,2) NOT NULL,
    sks_min   SMALLINT NOT NULL,
    sks_maks  SMALLINT NOT NULL,
    CHECK (ipk_maks >= ipk_min AND sks_maks >= sks_min)
);

INSERT INTO kebijakan_sks (ipk_min, ipk_maks, sks_min, sks_maks) VALUES
 (0.00, 1.99, 12, 15),
 (2.00, 2.49, 12, 18),
 (2.50, 2.99, 12, 21),
 (3.00, 4.00, 12, 24);   -- sesuaikan dengan aturan kampus

-- ---------- KRS ----------
CREATE TABLE krs (
    id             BIGSERIAL PRIMARY KEY,
    nim            VARCHAR(20) NOT NULL REFERENCES mahasiswa(nim) ON DELETE CASCADE,
    id_periode     VARCHAR(10) NOT NULL REFERENCES periode(id_periode) ON DELETE RESTRICT,
    status         status_krs  NOT NULL DEFAULT 'DRAFT',
    catatan_revisi TEXT,
    diajukan_pada  TIMESTAMPTZ,
    diputuskan_oleh VARCHAR(20) REFERENCES dosen(id_dosen),
    diputuskan_pada TIMESTAMPTZ,
    dibuat_pada    TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (nim, id_periode)
);
CREATE INDEX idx_krs_status ON krs(status);

-- ---------- ISI KRS (Keranjang) ----------
CREATE TABLE krs_kelas (
    id_krs    BIGINT NOT NULL REFERENCES krs(id) ON DELETE CASCADE,
    id_kelas  BIGINT NOT NULL REFERENCES kelas(id) ON DELETE RESTRICT,
    ditambah_pada TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id_krs, id_kelas)                 -- BR-02: tidak boleh duplikat
);
CREATE INDEX idx_krs_kelas_kelas ON krs_kelas(id_kelas);

-- ---------- RIWAYAT STATUS KRS ----------
CREATE TABLE krs_riwayat (
    id          BIGSERIAL PRIMARY KEY,
    id_krs      BIGINT NOT NULL REFERENCES krs(id) ON DELETE CASCADE,
    status_lama status_krs,
    status_baru status_krs NOT NULL,
    catatan     TEXT,
    waktu       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- =====================================================================
-- FUNGSI BANTU
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_total_sks(p_id_krs BIGINT) RETURNS INTEGER AS $$
    SELECT COALESCE(SUM(mk.sks), 0)::INT
    FROM krs_kelas kk
    JOIN kelas k        ON k.id = kk.id_kelas
    JOIN mata_kuliah mk ON mk.kode_mk = k.kode_mk
    WHERE kk.id_krs = p_id_krs;
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION fn_batas_sks(p_ipk NUMERIC)
RETURNS TABLE (sks_min SMALLINT, sks_maks SMALLINT) AS $$
    SELECT sks_min, sks_maks FROM kebijakan_sks
    WHERE p_ipk BETWEEN ipk_min AND ipk_maks
    ORDER BY ipk_min DESC LIMIT 1;
$$ LANGUAGE sql STABLE;

-- =====================================================================
-- TRIGGER: validasi isi KRS (BR-01, BR-03, BR-04, BR-05)
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_krs_kelas_guard() RETURNS TRIGGER AS $$
DECLARE
    v_krs   krs%ROWTYPE;
    v_kelas kelas%ROWTYPE;
    v_ipk   NUMERIC;
    v_maks  SMALLINT;
    v_sks_baru INT;
    v_peserta  INT;
BEGIN
    SELECT * INTO v_krs FROM krs WHERE id = COALESCE(NEW.id_krs, OLD.id_krs) FOR UPDATE;

    IF v_krs.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'BR-01: KRS tidak dapat diubah (status %)', v_krs.status
            USING ERRCODE = 'P0001';
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;

    -- kunci kelas agar hitungan kuota aman dari race condition
    SELECT * INTO v_kelas FROM kelas WHERE id = NEW.id_kelas FOR UPDATE;

    IF v_kelas.id_periode <> v_krs.id_periode THEN
        RAISE EXCEPTION 'BR-05: Kelas bukan dari periode KRS ini' USING ERRCODE = 'P0005';
    END IF;

    SELECT COUNT(*) INTO v_peserta FROM krs_kelas WHERE id_kelas = NEW.id_kelas;
    IF v_peserta >= v_kelas.kuota THEN
        RAISE EXCEPTION 'BR-03: Kuota kelas penuh' USING ERRCODE = 'P0003';
    END IF;

    SELECT ipk INTO v_ipk FROM mahasiswa WHERE nim = v_krs.nim;
    SELECT sks_maks INTO v_maks FROM fn_batas_sks(v_ipk);
    SELECT sks INTO v_sks_baru FROM mata_kuliah WHERE kode_mk = v_kelas.kode_mk;

    IF fn_total_sks(v_krs.id) + v_sks_baru > COALESCE(v_maks, 0) THEN
        RAISE EXCEPTION 'BR-04: Melebihi batas SKS (maks % untuk IPK %)', v_maks, v_ipk
            USING ERRCODE = 'P0004';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER krs_kelas_guard
BEFORE INSERT OR DELETE ON krs_kelas
FOR EACH ROW EXECUTE FUNCTION trg_krs_kelas_guard();

-- =====================================================================
-- TRIGGER: alur status KRS + riwayat
-- DRAFT -> DIAJUKAN -> DISETUJUI, atau DIAJUKAN -> DRAFT (ditolak)
-- =====================================================================
CREATE OR REPLACE FUNCTION trg_krs_status() RETURNS TRIGGER AS $$
DECLARE
    v_ipk NUMERIC; v_min SMALLINT; v_total INT;
BEGIN
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT ( (OLD.status = 'DRAFT'    AND NEW.status = 'DIAJUKAN')
              OR (OLD.status = 'DIAJUKAN' AND NEW.status IN ('DISETUJUI','DRAFT')) ) THEN
            RAISE EXCEPTION 'Perubahan status % -> % tidak diizinkan', OLD.status, NEW.status;
        END IF;

        IF NEW.status = 'DIAJUKAN' THEN
            v_total := fn_total_sks(NEW.id);
            IF v_total = 0 THEN
                RAISE EXCEPTION 'BR-06: KRS kosong tidak dapat diajukan' USING ERRCODE = 'P0006';
            END IF;
            SELECT ipk INTO v_ipk FROM mahasiswa WHERE nim = NEW.nim;
            SELECT sks_min INTO v_min FROM fn_batas_sks(v_ipk);
            IF v_total < COALESCE(v_min, 0) THEN
                RAISE EXCEPTION 'BR-06: SKS (%) kurang dari minimal (%)', v_total, v_min
                    USING ERRCODE = 'P0006';
            END IF;
            NEW.diajukan_pada := now();
        END IF;

        INSERT INTO krs_riwayat (id_krs, status_lama, status_baru, catatan)
        VALUES (NEW.id, OLD.status, NEW.status, NEW.catatan_revisi);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER krs_status
BEFORE UPDATE ON krs
FOR EACH ROW EXECUTE FUNCTION trg_krs_status();

-- =====================================================================
-- FUNGSI AKSI DOSEN WALI (hanya untuk mahasiswa bimbingan sendiri)
-- =====================================================================
CREATE OR REPLACE FUNCTION fn_setujui_krs(p_id_dosen VARCHAR, p_nim VARCHAR, p_periode VARCHAR)
RETURNS VOID AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM mahasiswa WHERE nim = p_nim AND id_dosen_wali = p_id_dosen) THEN
        RAISE EXCEPTION 'Akses ditolak: bukan mahasiswa bimbingan Anda';
    END IF;
    UPDATE krs SET status = 'DISETUJUI', catatan_revisi = NULL,
                   diputuskan_oleh = p_id_dosen, diputuskan_pada = now()
    WHERE nim = p_nim AND id_periode = p_periode;
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_tolak_krs(p_id_dosen VARCHAR, p_nim VARCHAR, p_periode VARCHAR, p_catatan TEXT)
RETURNS VOID AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM mahasiswa WHERE nim = p_nim AND id_dosen_wali = p_id_dosen) THEN
        RAISE EXCEPTION 'Akses ditolak: bukan mahasiswa bimbingan Anda';
    END IF;
    UPDATE krs SET status = 'DRAFT', catatan_revisi = p_catatan,
                   diputuskan_oleh = p_id_dosen, diputuskan_pada = now()
    WHERE nim = p_nim AND id_periode = p_periode;
END; $$ LANGUAGE plpgsql;

-- =====================================================================
-- VIEW untuk halaman / dashboard
-- =====================================================================

-- Katalog mata kuliah mahasiswa (hal. 11) + sisa kuota
CREATE VIEW v_katalog_kelas AS
SELECT k.id AS id_kelas, k.id_periode, mk.kode_mk, mk.nama_mk, mk.sks, k.nama_kelas,
       d.nama AS dosen_pengampu, k.hari, k.jam_mulai, k.jam_selesai, k.ruang,
       k.kuota,
       (SELECT COUNT(*) FROM krs_kelas kk WHERE kk.id_kelas = k.id) AS terisi,
       k.kuota - (SELECT COUNT(*) FROM krs_kelas kk WHERE kk.id_kelas = k.id) AS sisa_kuota
FROM kelas k
JOIN mata_kuliah mk ON mk.kode_mk = k.kode_mk
LEFT JOIN dosen d   ON d.id_dosen = k.id_dosen_pengampu;

-- Keranjang / cetak KRS (hal. 12 & 15)
CREATE VIEW v_isi_krs AS
SELECT kr.id AS id_krs, kr.nim, m.nama AS nama_mahasiswa, kr.id_periode, kr.status,
       mk.kode_mk, mk.nama_mk, mk.sks, k.nama_kelas, k.hari, k.jam_mulai, k.jam_selesai, k.ruang
FROM krs kr
JOIN mahasiswa m    ON m.nim = kr.nim
JOIN krs_kelas kk   ON kk.id_krs = kr.id
JOIN kelas k        ON k.id = kk.id_kelas
JOIN mata_kuliah mk ON mk.kode_mk = k.kode_mk;

-- Status & riwayat KRS mahasiswa (hal. 14)
CREATE VIEW v_status_krs AS
SELECT kr.nim, kr.id_periode, kr.status, kr.catatan_revisi, fn_total_sks(kr.id) AS total_sks,
       kr.diajukan_pada, kr.diputuskan_pada
FROM krs kr;

-- Daftar mahasiswa + IPK (hal. 8, hanya kaprodi & admin)
CREATE VIEW v_daftar_mahasiswa AS
SELECT m.nim, m.nama, m.angkatan, m.semester, m.ipk, m.ips_terakhir,
       d.nama AS dosen_wali,
       (SELECT sks_maks FROM fn_batas_sks(m.ipk)) AS sks_maks,
       (SELECT sks_min  FROM fn_batas_sks(m.ipk)) AS sks_min
FROM mahasiswa m LEFT JOIN dosen d ON d.id_dosen = m.id_dosen_wali;

-- Mahasiswa bimbingan yang mengajukan KRS (hal. 16)
CREATE VIEW v_pengajuan_bimbingan AS
SELECT m.id_dosen_wali, kr.nim, m.nama, m.ipk, kr.id_periode, kr.status,
       fn_total_sks(kr.id) AS total_sks, kr.diajukan_pada
FROM krs kr JOIN mahasiswa m ON m.nim = kr.nim
WHERE kr.status = 'DIAJUKAN';

-- Laporan Kaprodi (hal. 18): rekap status per periode
CREATE VIEW v_laporan_status_krs AS
SELECT id_periode,
       COUNT(*) FILTER (WHERE status = 'DRAFT')     AS draft,
       COUNT(*) FILTER (WHERE status = 'DIAJUKAN')  AS diajukan,
       COUNT(*) FILTER (WHERE status = 'DISETUJUI') AS disetujui,
       COUNT(*)                                     AS total
FROM krs GROUP BY id_periode;

-- Laporan Kaprodi: peminat & keterisian kelas
CREATE VIEW v_laporan_kelas AS
SELECT id_periode, kode_mk, nama_mk, nama_kelas, kuota, terisi, sisa_kuota,
       ROUND(100.0 * terisi / NULLIF(kuota,0), 1) AS persen_terisi
FROM v_katalog_kelas;

-- Statistik dashboard Admin
CREATE VIEW v_stat_admin AS
SELECT (SELECT COUNT(*) FROM mahasiswa)   AS jml_mahasiswa,
       (SELECT COUNT(*) FROM dosen)       AS jml_dosen,
       (SELECT COUNT(*) FROM mata_kuliah) AS jml_mk,
       (SELECT id_periode FROM periode WHERE is_aktif) AS periode_aktif;
