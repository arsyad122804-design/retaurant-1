# MAISON RESTO - SISTEM RESTORAN HAUTE GASTRONOMIE

Sistem manajemen restoran modern dengan arsitektur **4 Halaman Terpisah**, **3 Sistem Login Mandiri**, dan **1 Halaman Pemesanan Tamu Tanpa Login**. Seluruh divisi terhubung secara real-time melalui satu database SQLite terintegrasi.

---

## 🏛 DAFTAR HALAMAN & SISTEM LOGIN TERPISAH

| Bagian | URL Akses | URL Login | Akses & Proteksi |
|---|---|---|---|
| **1. Customer / Tamu** | `http://localhost:3000/pesan` | *Tanpa Login* | Publik (Langsung memilih hidangan & pesan) |
| **2. Kasir** | `http://localhost:3000/kasir` | `http://localhost:3000/kasir/login` | Khusus Kasir (Dilarang masuk portal Owner) |
| **3. Dapur & Gudang** | `http://localhost:3000/dapur` | `http://localhost:3000/dapur/login` | Khusus Dapur (Dilarang masuk Owner/Kasir) |
| **4. Owner & Eksekutif** | `http://localhost:3000/owner` | `http://localhost:3000/owner/login` | Khusus Owner (Akses penuh seluruh sistem) |
| **Beranda Utama** | `http://localhost:3000/` | - | Gerbang navigasi ke seluruh portal |

---

## 🔑 KREDENSIAL BAWAAN (DEFAULT ACCOUNTS)

| Peran (Role) | Email | Password | Hak Akses |
|---|---|---|---|
| **Owner** | `owner@maisonresto.com` | `owner123` | Akses penuh finansial, laba/rugi, stok, & kelola akun |
| **Kasir** | `kasir@maisonresto.com` | `kasir123` | Kasir, kelola pesanan, pembayaran, cetak struk |
| **Dapur & Gudang** | `dapur@maisonresto.com` | `dapur123` | Antrean masak, menu & resep, stok bahan masuk |

---

## 🚀 CARA MENJALANKAN APLIKASI

Aplikasi dibangun menggunakan Node.js murni (zero external dependencies) dengan database bawaan `node:sqlite`.

1. **Jalankan Server:**
   ```bash
   node server.js
   ```
   *Atau:*
   ```bash
   npm start
   ```

2. **Buka di Browser:**
   - **Pemesanan Tamu**: `http://localhost:3000/pesan`
   - **Kasir**: `http://localhost:3000/kasir`
   - **Dapur & Gudang**: `http://localhost:3000/dapur`
   - **Owner**: `http://localhost:3000/owner`

3. **Menjalankan Pengujian Otomatis:**
   ```bash
   node test-direct.js
   ```

---

## 🌟 FITUR UTAMA SETIAP HALAMAN

### 1. Halaman Customer / Tamu (`/pesan`)
- **Tanpa Login**: Customer langsung melihat menu restoran begitu membuka halaman.
- Foto beresolusi tinggi, harga, kategori (Appetizer, Main Course, Pasta & Risotto, Dessert, Beverage), deskripsi hidangan.
- Filter pencarian dan navigasi kategori.
- Pengaturan jumlah pesanan (+ / -) dan keranjang belanja dinamis.
- Pengisian Nama Pelanggan dan Nomor Meja.
- Catatan khusus untuk dapur (cth. "Medium rare", "Less sweet").
- Setelah menekan tombol pesan, pesanan seketika masuk ke antrean Kasir dan Dapur.

### 2. Halaman Kasir (`/kasir`)
- Login mandiri di `/kasir/login`.
- Antrean pesanan aktif dari meja tamu dengan status real-time (`Pending`, `Cooking`, `Ready`, `Paid`, `Unpaid`).
- Pengelolaan pembayaran:
  - Tunai (Cash) dengan kalkulasi uang kembalian dan tombol nominal cepat.
  - QRIS Dinamis.
  - Kartu Debit & Kartu Kredit.
- **Pencetakan Struk Belanja**: Format thermal receipt restoran mewah yang siap dicetak ke printer struk atau disimpan sebagai PDF.
- Riwayat transaksi lengkap dengan pencarian nomor nota, nama tamu, meja, dan filter tanggal.
- **Proteksi Akses**: Kasir yang mencoba membuka `/owner` akan otomatis diblokir dan dikembalikan ke `/kasir`.

### 3. Halaman Dapur dan Gudang (`/dapur`)
- Login mandiri di `/dapur/login`.
- **Tiket Antrean Masak**: Status memasak (`Mulai Memasak` -> `Siap Disajikan` -> `Selesai`).
- **Kelola Menu & Resep**:
  - Tambah, edit, dan hapus hidangan dan minuman.
  - Menghubungkan 1 porsi menu dengan bahan baku dan takarannya (cth: 1 porsi Wagyu MB9 butuh 0.25 kg Daging Wagyu, 0.03 kg French Butter).
- **Pemotongan Stok Resep Otomatis**:
  - Setiap kali pesanan diproses dan dibayar, stok bahan baku di Gudang otomatis terpotong sesuai resep!
- **Catat Bahan Masuk (Restock)**:
  - Pencatatan bahan masuk dari supplier yang otomatis menambah stok fisik dan mencatat pengeluaran restoran.
- **Peringatan Stok Menipis**: Banner visual dan badge peringatan ketika stok berada di bawah batas minimum.
- **Log Mutasi Stok**: Audit mutasi keluar masuk bahan secara transparan.
- **Proteksi Akses**: Dapur tidak diizinkan masuk ke Dashboard Owner maupun halaman Kasir.

### 4. Halaman Owner & Eksekutif (`/owner`)
- Login mandiri di `/owner/login`.
- **Pemantauan Pendapatan Komprehensif**:
  - Pendapatan Harian (Daily Revenue) & jumlah pesanan hari ini.
  - Pendapatan Mingguan (Weekly Revenue) 7 hari terakhir.
  - Pendapatan Bulanan (Monthly Revenue) bulan berjalan.
  - Pendapatan Tahunan (Yearly Revenue) tahun 2026.
- **Analisis Finansial & Laba Rugi**:
  - Total Pendapatan Kotor (Gross Revenue).
  - Total Beban Pengeluaran (Bahan baku + Operasional).
  - Keuntungan Bersih (Net Profit) & Margin Laba (%).
  - Tombol pencatatan pengeluaran operasional (listrik, gaji, maintenance).
- **Grafik Tren Penjualan 7 Hari**: Visualisasi omzet harian.
- **5 Menu Terlaris**: Peringkat menu favorit tamu berdasarkan porsi terjual dan omzet.
- **Audit Stok & Valuasi Aset Gudang**: Nilai total aset persediaan serta daftar bahan yang hampir habis.
- **Laporan Penjualan & Pengeluaran Terperinci**: Filter tanggal dan rincian transaksi lengkap.
- **Manajemen Akun Pengguna**: Tambah akun baru, ubah peran (Owner/Kasir/Dapur), reset password, aktifkan/nonaktifkan status akun, dan hapus akun.

---

## 🎨 DESAIN: HITAM & EMAS (BLACK & GOLD LUXURY)
Mengusung estetika Haute Gastronomie kelas atas:
- **Latar Belakang**: Onyx & Obsidian hitam mewah (`#08090c`, `#101218`, `#151821`).
- **Aksen Emas**: Emas murni & Champagne (`#d4af37`, `#f7e49e`, `#996515`).
- **Tipografi**: Judul bergaya klasik *Cinzel / Playfair Display* dipadukan dengan teks modern *Plus Jakarta Sans*.
- **Elemen UI**: Kartu berbingkai emas bercahaya (gold glow), badge status elegan, tata letak responsif untuk komputer, tablet, maupun smartphone.
