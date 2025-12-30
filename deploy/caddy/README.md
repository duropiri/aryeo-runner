# Caddy Reverse Proxy Setup (Option B - Alternative)

Use this if you prefer a traditional reverse proxy instead of Cloudflare Tunnel.

## Prerequisites

- Ubuntu 22.04 LTS
- DNS A record pointing to your server's IP
- Ports 80 and 443 open on firewall
- Cloudflare DNS (orange cloud) optional but recommended

## Step 1: Install Caddy

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

## Step 2: Configure Firewall

```bash
# Allow HTTP and HTTPS
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw reload
```

## Step 3: Configure Caddy

```bash
# Backup default config
sudo cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.backup

# Copy your config (edit domain first!)
sudo cp Caddyfile /etc/caddy/Caddyfile
sudo nano /etc/caddy/Caddyfile
# Update: email and hostname

# Create log directory
sudo mkdir -p /var/log/caddy
sudo chown caddy:caddy /var/log/caddy

# Validate config
sudo caddy validate --config /etc/caddy/Caddyfile

# Reload Caddy
sudo systemctl reload caddy
```

## Step 4: Cloudflare Configuration (if using)

1. Go to Cloudflare dashboard → SSL/TLS
2. Set mode to **Full (Strict)**
3. Go to DNS → ensure the record is proxied (orange cloud)

## Step 5: Verify

```bash
# Check Caddy status
sudo systemctl status caddy

# Test HTTPS
curl https://runner.yourdomain.com/health
```

## Troubleshooting

### View logs
```bash
sudo journalctl -u caddy -f
tail -f /var/log/caddy/runner.log
```

### Certificate issues
```bash
# Force certificate renewal
sudo caddy reload --config /etc/caddy/Caddyfile
```
