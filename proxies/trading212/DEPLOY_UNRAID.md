# Deploying Trading 212 Proxy on Unraid NAS

The proxy is a stateless FastAPI application that forwards requests to Trading 212's API. It requires no credentials, databases, or persistent storage.

---

## Prerequisites

- Unraid 6.10+ with Docker enabled
- Access to the Unraid web UI or SSH
- At least 100 MB free space
- Port 8000 available (or choose a different external port)

---

## Option 1: Unraid UI (Easiest)

### Step 1: Prepare the proxy files

Clone/copy the repository to your Unraid array:

```bash
ssh root@YOUR_UNRAID_IP
cd /mnt/user/appdata  # or any persistent location
git clone https://github.com/dpremoli/Wealthfolio-Trading212-Add-On.git trading212-proxy
cd trading212-proxy
```

Or manually copy these three files:
- `main.py`
- `requirements.txt`
- `Dockerfile`

### Step 2: Add container via Unraid UI

1. Go to **Settings → Docker** and ensure Docker is enabled
2. Go to **Docker** tab
3. Click **Add Container**
4. Fill in the form:
   - **Name:** `trading212-proxy`
   - **Repository:** `python:3.11-slim`
   - **Tag:** `latest`
   - **Privileged:** No
   - **Restart Policy:** Unless stopped
   - **Console Shell:** Unspecified

5. Under **Ports**, add:
   - **Port 1:** Container Port `8000`, Host Port `8000`, Protocol `TCP`

6. Under **Volumes**, add:
   - **Volume 1:** Host Path `/mnt/user/appdata/trading212-proxy`, Container Path `/app`, Read-only: No, Sync: Yes

7. Under **Post Arguments**, paste:
   ```
   bash -c "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000"
   ```

8. Click **Add**

The container will start and pull dependencies on first run (~2-3 minutes).

---

## Option 2: Docker Compose (Recommended for updates)

### Step 1: Clone the repo

```bash
ssh root@YOUR_UNRAID_IP
cd /mnt/user/appdata
git clone https://github.com/dpremoli/Wealthfolio-Trading212-Add-On.git trading212-proxy
cd trading212-proxy
```

### Step 2: Update docker-compose.yml

Edit `docker-compose.yml` and replace the volume path:

```yaml
volumes:
  - /mnt/user/appdata/trading212-proxy:/app  # Update this path
```

### Step 3: Start the container

```bash
docker-compose up -d
```

To check logs:
```bash
docker-compose logs -f trading212-proxy
```

To stop:
```bash
docker-compose down
```

---

## Option 3: Direct Docker Run (Minimal)

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

---

## Verification

Once the container is running, verify it's healthy:

### From Unraid terminal:
```bash
curl http://localhost:8000/health
# Expected response: {"status":"ok"}
```

### From another machine:
```bash
curl http://YOUR_UNRAID_IP:8000/health
```

### Check logs in Unraid UI:
1. Go to **Docker** tab
2. Click the **trading212-proxy** container
3. Scroll down to see real-time logs

---

## Configuration

### Change port

If port 8000 is unavailable, modify your deploy method:

**Unraid UI:** Ports section, change Host Port to (e.g.) `9000`

**docker-compose.yml:**
```yaml
ports:
  - "9000:8000"  # Host:Container
```

**Docker run:**
```bash
-p 9000:8000  # Host:Container
```

Then update the proxy URL in Wealthfolio settings to `http://YOUR_UNRAID_IP:9000`.

### Environment variables

The proxy needs no configuration. The `PORT` environment variable is optional and defaults to `8000`.

---

## Updating

If a new version is released:

### With docker-compose:
```bash
cd /mnt/user/appdata/trading212-proxy
git pull origin main
docker-compose restart trading212-proxy
```

### With Docker run:
Stop the old container and re-run the command with updated files.

---

## Security Notes

- The proxy holds **no credentials** and keeps no state.
- The API key lives only in Wealthfolio's encrypted keyring on your machine.
- The proxy is exposed on your LAN; if you access Wealthfolio over WAN, use a VPN or firewall rules.
- Only the fixed `live` and `demo` Trading 212 hosts are allowed (no SSRF risk).

---

## Troubleshooting

**Container won't start:**
```bash
docker logs trading212-proxy
```

**Dependencies not installing:**
Make sure `requirements.txt` is in the volume directory.

**Port already in use:**
```bash
netstat -tlnp | grep 8000
# Kill the conflicting process or use a different port
```

**Health check failing:**
Wait 10-30 seconds for dependencies to install on first run. Check logs:
```bash
docker logs --tail 50 trading212-proxy
```

**Can't reach from another machine:**
- Verify firewall allows port 8000/9000
- Check your Unraid IP: `hostname -I`
- Ensure container is running: `docker ps | grep trading212`

---

## Next Steps

1. Note your Unraid IP and proxy port (default: `http://YOUR_UNRAID_IP:8000`)
2. Install the Wealthfolio Trading 212 add-on (addon.zip)
3. In Wealthfolio settings, enter the proxy URL and your Trading 212 API key (demo first to test)
4. Click **Connect** and **Sync Now**

Enjoy seamless Trading 212 syncing! 📈
