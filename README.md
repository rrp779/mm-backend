# mm-backend
# mm-backend

## Local Setup (Testing)

### 1) Install dependencies

```bash
npm install
```

### 2) Create `.env`

- Copy `mm-backend/.env.example` to `mm-backend/.env`
- Fill in all values (Shopify token, Razorpay keys, Mongo URI, etc.)

Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

### 3) Start the server

```bash
node server.js
```

If you use `nodemon`:

```bash
npx nodemon server.js
```
