# Cloudflare Tunnel Setup (Option A - Recommended)

This guide sets up a Cloudflare Tunnel to securely expose the Aryeo Delivery Runner without opening ports on your firewall.

## Prerequisites

- Ubuntu 22.04 LTS or later
- Cloudflare account with a domain configured
- Docker and Docker Compose installed

## Step 1: Install cloudflared

```bash
# Download and install cloudflared
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o cloudflared.deb
sudo dpkg -i cloudflared.deb
rm cloudflared.deb

# Verify installation
cloudflared --version
```

## Step 2: Authenticate with Cloudflare

```bash
# This opens a browser to authenticate (use --no-autoupdate to prevent auto-updates)
cloudflared tunnel login

# This creates ~/.cloudflared/cert.pem
```

## Step 3: Create the Tunnel

```bash
# Create a new tunnel named "aryeo-runner"
cloudflared tunnel create aryeo-runner

# This outputs a tunnel UUID like: a1b2c3d4-e5f6-7890-abcd-ef1234567890
# And creates ~/.cloudflared/<TUNNEL_UUID>.json credentials file
```

## Step 4: Configure DNS Route

```bash
# Replace with your actual domain and tunnel name
cloudflared tunnel route dns aryeo-runner runner.yourdomain.com

# This creates a CNAME record pointing to your tunnel
```

## Step 5: Set Up Configuration

```bash
# Create config directory
sudo mkdir -p /etc/cloudflared

# Copy credentials file (replace UUID with your tunnel UUID)
sudo cp ~/.cloudflared/<TUNNEL_UUID>.json /etc/cloudflared/credentials.json
sudo chmod 600 /etc/cloudflared/credentials.json

# Copy and edit config file
sudo cp config.yml /etc/cloudflared/config.yml
sudo nano /etc/cloudflared/config.yml
# Update: tunnel, credentials-file path, and hostname
```

## Step 6: Install as systemd Service

```bash
# Copy the service file
sudo cp cloudflared.service /etc/systemd/system/cloudflared.service

# Reload systemd
sudo systemctl daemon-reload

# Enable and start the service
sudo systemctl enable cloudflared
sudo systemctl start cloudflared

# Check status
sudo systemctl status cloudflared

# View logs
sudo journalctl -u cloudflared -f
```

## Step 7: Verify the Tunnel

```bash
# Check tunnel status
cloudflared tunnel info aryeo-runner

# Test the endpoint (should return health check)
curl https://runner.yourdomain.com/health
```

## Troubleshooting

### Check tunnel status
```bash
cloudflared tunnel list
cloudflared tunnel info aryeo-runner
```

### View logs
```bash
sudo journalctl -u cloudflared -f
```

### Restart tunnel
```bash
sudo systemctl restart cloudflared
```

### Test local connection
```bash
# Make sure Docker services are running
docker-compose -f docker-compose.production.yml ps

# Test local API
curl http://127.0.0.1:8080/health
```

## Security Notes

1. The tunnel credentials file (`credentials.json`) is sensitive - protect it
2. Cloudflare provides DDoS protection automatically
3. All traffic is encrypted end-to-end
4. No inbound ports need to be opened on your firewall
