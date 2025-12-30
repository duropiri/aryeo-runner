# Nginx Reverse Proxy Setup (Option B - Alternative)

Use this if you prefer Nginx instead of Caddy or Cloudflare Tunnel.

## Prerequisites

- Ubuntu 22.04 LTS
- DNS A record pointing to your server's IP
- Ports 80 and 443 open on firewall

## Step 1: Install Nginx and Certbot

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
```

## Step 2: Configure Firewall

```bash
sudo ufw allow 'Nginx Full'
sudo ufw reload
```

## Step 3: Configure Nginx

```bash
# Copy config (edit domain first!)
sudo cp runner.conf /etc/nginx/sites-available/runner
sudo nano /etc/nginx/sites-available/runner
# Update: server_name

# Enable the site
sudo ln -s /etc/nginx/sites-available/runner /etc/nginx/sites-enabled/

# Test config
sudo nginx -t

# Reload Nginx
sudo systemctl reload nginx
```

## Step 4: Obtain TLS Certificate

```bash
# Create webroot directory for ACME challenge
sudo mkdir -p /var/www/certbot

# Get certificate
sudo certbot --nginx -d runner.yourdomain.com

# Test auto-renewal
sudo certbot renew --dry-run
```

## Step 5: Cloudflare Configuration (if using)

If you're using Cloudflare DNS proxy (orange cloud):

1. Go to SSL/TLS → set to **Full (Strict)**
2. Or use Cloudflare Origin Certificate instead of Let's Encrypt

### Using Cloudflare Origin Certificate

```bash
# Create certificate directory
sudo mkdir -p /etc/ssl/cloudflare

# Go to Cloudflare Dashboard → SSL/TLS → Origin Server
# Create a certificate and save as:
#   /etc/ssl/cloudflare/origin.pem (certificate)
#   /etc/ssl/cloudflare/origin.key (private key)

# Update nginx config to use these certs
# (uncomment the Cloudflare lines, comment out certbot lines)
```

## Step 6: Verify

```bash
# Check Nginx status
sudo systemctl status nginx

# Test HTTPS
curl https://runner.yourdomain.com/health
```

## Troubleshooting

### View logs
```bash
sudo tail -f /var/log/nginx/runner.access.log
sudo tail -f /var/log/nginx/runner.error.log
```

### Test configuration
```bash
sudo nginx -t
```

### Reload after changes
```bash
sudo systemctl reload nginx
```
