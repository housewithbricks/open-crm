# Open CRM landing page: static files served by nginx.
# Listens on $PORT (default 8080), so it works on Railway, Render and similar hosts.
FROM nginx:1.27-alpine

ENV PORT=8080 \
    NGINX_ENVSUBST_OUTPUT_DIR=/etc/nginx/conf.d \
    NGINX_ENVSUBST_FILTER=^PORT$

# The official image renders /etc/nginx/templates/*.template into
# $NGINX_ENVSUBST_OUTPUT_DIR at start-up, substituting $PORT.
RUN rm -f /etc/nginx/conf.d/default.conf
COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY index.html favicon.svg og.png /usr/share/nginx/html/
COPY assets/ /usr/share/nginx/html/assets/

EXPOSE 8080
