FROM python:3.13-alpine

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY vpn/discovery-relay/relay.py /app/relay.py
COPY vpn/discovery-relay/tests /app/tests

RUN python -m unittest discover -s /app/tests -v

USER 65534:65534

ENTRYPOINT ["python", "/app/relay.py"]
