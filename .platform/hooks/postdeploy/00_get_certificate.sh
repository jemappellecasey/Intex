#!/usr/bin/env bash
# .platform/hooks/postdeploy/00_get_certificate.sh
sudo certbot -n -d intex312final.is404.net --nginx --agree-tos --email blakebrightworth@gmail.com
