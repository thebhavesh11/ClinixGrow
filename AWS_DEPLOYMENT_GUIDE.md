# FlowBot AI — AWS EC2 Production Deployment Guide

This guide walks you through deploying FlowBot AI on an AWS EC2 instance (Ubuntu 22.04 or 24.04 LTS) so your clients can access their dashboard via your custom domain with free SSL (HTTPS).

---

## 1. Recommended EC2 Instance Spec
- **Instance Type**: `t3.medium` (2 vCPU, 4GB RAM) or `t3a.medium`
  *(Since Puppeteer Chromium uses ~200-300MB per WhatsApp session, 4GB RAM easily supports 5-8 clients simultaneously).*
- **OS**: Ubuntu 22.04 LTS (64-bit x86)
- **Storage**: 20 GB gp3 SSD
- **Security Group Inbound Rules**:
  - Port `22` (SSH) — Your IP
  - Port `80` (HTTP) — Anywhere (0.0.0.0/0)
  - Port `443` (HTTPS) — Anywhere (0.0.0.0/0)

---

## 2. One-Click Setup on Server

SSH into your EC2 instance:
```bash
ssh -i your-key.pem ubuntu@your-ec2-ip
```

Clone your repository onto EC2:
```bash
git clone https://github.com/your-username/your-repo.git /home/ubuntu/flowbot
cd /home/ubuntu/flowbot
```

Make deployment script executable and run it:
```bash
chmod +x deploy-aws.sh
./deploy-aws.sh
```
This script automatically:
1. Installs Node.js 20 LTS, Python 3, Git, Nginx, Certbot, PM2.
2. Installs all required Linux Chromium libraries for headless WhatsApp Web.
3. Builds the Next.js frontend for production.

---

## 3. Run Services 24/7 with PM2

Start all 3 services in the background:
```bash
# 1. Backend (FastAPI) — Note: --cwd is REQUIRED so Python finds main.py
pm2 start "venv/bin/uvicorn main:app --host 127.0.0.1 --port 8000" --cwd "/home/ubuntu/flowbot/backend" --name flowbot-backend

# 2. WhatsApp Bridge (Node.js)
pm2 start "node index.js" --cwd "/home/ubuntu/flowbot/whatsapp-bridge" --name flowbot-bridge

# 3. Frontend (Next.js)
pm2 start "npm start" --cwd "/home/ubuntu/flowbot/frontend" --name flowbot-frontend

# Save and enable auto-start on server reboot
pm2 save
pm2 startup
```

Check status anytime:
```bash
pm2 status
pm2 logs
```

---

## 4. Configure Nginx Reverse Proxy with Domain & SSL

Create an Nginx configuration file:
```bash
sudo nano /etc/nginx/sites-available/flowbot
```

Paste the following configuration (replace `yourdomain.com` with your actual domain or subdomain e.g. `app.yourdomain.com`):
```nginx
server {
    server_name yourdomain.com;

    # Frontend (Next.js)
    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }

    # Backend API
    location /api {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable site and restart Nginx:
```bash
sudo ln -s /etc/nginx/sites-available/flowbot /etc/nginx/sites-enabled/
sudo rm /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl restart nginx
```

### Install Free SSL Certificate (HTTPS)
```bash
sudo certbot --nginx -d yourdomain.com
```

Now your app and client portals are live securely over HTTPS:
- Admin Panel: `https://yourdomain.com`
- Client Portal: `https://yourdomain.com/portal/[client_secret_token]`

