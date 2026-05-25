# Unraid Deployment Quick Reference

## TL;DR — One-liner (if on Unraid via SSH)

```bash
bash <(curl -fsSL https://raw.githubusercontent.com/dpremoli/Wealthfolio-Trading212-Add-On/main/deploy-unraid.sh)
```

Then visit `http://YOUR_UNRAID_IP:8000/health` to verify.

---

## Manual Deployment (5 steps)

### 1. SSH to Unraid
```bash
ssh root@YOUR_UNRAID_IP
```

### 2. Clone the repo
```bash
mkdir -p /mnt/user/appdata
cd /mnt/user/appdata
git clone https://github.com/dpremoli/Wealthfolio-Trading212-Add-On.git trading212-proxy
cd trading212-proxy
```

### 3. Start the proxy (pick one method)

**Option A: Docker Compose**
```bash
docker-compose up -d
```

**Option B: Direct Docker**
```bash
docker run -d \
  --name trading212-proxy \
  --restart unless-stopped \
  -p 8000:8000 \
  -v /mnt/user/appdata/trading212-proxy:/app \
  -w /app \
  python:3.11-slim \
  bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"
```

### 4. Wait 30-60 seconds (first run installs dependencies)

### 5. Verify
```bash
curl http://localhost:8000/health
# Response: {"status":"ok"}
```

---

## Unraid UI Method (No SSH)

1. Go to **Settings → Docker** (enable if not already)
2. Go to **Docker** tab → **Add Container**
3. **Name:** `trading212-proxy`
4. **Repository:** `python:3.11-slim`
5. **Ports:** Host `8000` → Container `8000`
6. **Volumes:** `/mnt/user/appdata/trading212-proxy` → `/app`
7. **Post Arguments:**
   ```
   bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"
   ```
8. Click **Add**

Wait for dependencies to install. Then verify at `http://YOUR_UNRAID_IP:8000/health`.

---

## Use in Wealthfolio

1. Install the addon: `Settings → Add-ons → Install from ZIP` (upload `dist/trading212-addon.zip`)
2. Open **Trading 212** in sidebar → **Settings**
3. **Proxy URL:** `http://YOUR_UNRAID_IP:8000`
4. **Environment:** Demo (test first) or Live
5. **API Key:** [from Trading 212 app]
6. **API Secret:** [from Trading 212 app]
7. Click **Connect**
8. Go to dashboard → **Sync Now**

---

## Common Issues

| Problem | Solution |
|---------|----------|
| Container won't start | `docker logs trading212-proxy` |
| Port 8000 in use | Change to `-p 9000:8000` in docker command, then use `http://IP:9000` in Wealthfolio |
| Can't reach from other machine | Check firewall allows port 8000; verify IP with `hostname -I` |
| Slow first start | Dependencies (pip install) take ~30-60s on first run; check logs |
| Health check fails | Wait 60 seconds and try again; dependencies may still be installing |

---

## Troubleshooting

**Check container status:**
```bash
docker ps | grep trading212
```

**View logs:**
```bash
docker logs -f trading212-proxy
```

**Restart the proxy:**
```bash
docker restart trading212-proxy
```

**Remove and redeploy:**
```bash
docker rm -f trading212-proxy
# Then re-run the docker run command above
```

---

## Documentation

- **Full guide:** `DEPLOY_UNRAID.md`
- **Architecture:** `ARCHITECTURE.md`
- **User guide:** `README.md`

---

## Support

Found an issue? Check [GitHub Issues](https://github.com/dpremoli/Wealthfolio-Trading212-Add-On/issues).
