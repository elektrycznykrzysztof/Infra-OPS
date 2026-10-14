FROM postgres:16-alpine

COPY postgres-logging-entrypoint.sh /usr/local/bin/postgres-logging-entrypoint.sh
RUN chmod 755 /usr/local/bin/postgres-logging-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/postgres-logging-entrypoint.sh"]
CMD ["postgres"]
