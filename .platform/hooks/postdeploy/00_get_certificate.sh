#!/usr/bin/env bash
# .platform/hooks/postdeploy/00_get_certificate.sh
sudo certbot -n -d http://intex-env.eba-ipmmpnyf.us-east-1.elasticbeanstalk.com/ --nginx --agree-tos --email blakebrightworth@gmail.com