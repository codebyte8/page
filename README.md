# 📱 Facebook Auto Poster

An automated Facebook posting system with a web-based admin dashboard.

## ✨ Features

- 🔐 Secure login system (Firebase Authentication)
- 📄 Facebook Page Management
- 📊 Google Sheets Integration
- ⚡ Instant Post (Text, Image, Link)
- 🤖 Auto Post via GitHub Actions
- 📋 Post Logs
- 🔑 Token Validity Checker
- 📱 Fully Responsive Dashboard

## 🚀 Quick Start

### 1. Firebase Setup
1. Go to [Firebase Console](https://console.firebase.google.com/)
2. Enable **Authentication** → Email/Password
3. Create **Cloud Firestore** database
4. Generate service account key (Project Settings → Service accounts)

### 2. GitHub Setup
1. Fork/clone this repository
2. Add GitHub Secret: `FIREBASE_SERVICE_ACCOUNT` (paste your service account JSON)
3. Enable GitHub Pages (Settings → Pages → main branch)

### 3. Access Dashboard
Visit: `https://YOUR_USERNAME.github.io/fb-auto-poster/login.html`

## 🔧 Configuration

- Auto post schedule: Edit `.github/workflows/auto-post.yml` (cron schedule)
- Custom message: Modify `auto-post.js` or use workflow dispatch inputs

## 📝 License

MIT