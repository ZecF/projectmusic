# Vall Music — Heroku Deployment Package

Dedicated, standalone high-fidelity music streaming platform with dynamic ambient aura, 10-band DSP equalizer, synchronized karaoke lyrics, and audio link resolution.

## 🚀 Cara Deploy ke Heroku

### Opsi 1: Menggunakan Heroku CLI
```bash
# 1. Masuk ke folder proyek
cd vall-music-heroku

# 2. Inisialisasi Git
git init
git add .
git commit -m "Deploy Vall Music"

# 3. Buat aplikasi Heroku
heroku create nama-aplikasi-vall

# 4. Push ke Heroku
git push heroku main

# 5. Buka web app
heroku open
```

### Opsi 2: Menggunakan GitHub / Dashboard Heroku
1. Upload isi folder atau ekstrak ZIP ini ke repository GitHub Anda.
2. Buka dashboard Heroku -> Buat aplikasi baru.
3. Hubungkan ke GitHub repository tersebut dan klik **Deploy Branch**.
4. Heroku akan otomatis mendeteksi `Procfile` (`web: node vall-server.js`) dan menginstall dependencies via `package.json`.

---
⚡ **Vall Music Studio Platform**
