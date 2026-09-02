FROM mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f

WORKDIR /app
ENV PYTHONPATH=/app

COPY https/integrations.json /app/integrations.json
COPY https/app /app/app
COPY https/tests /tests

RUN python -m py_compile /app/app/*.py /app/app/strategies/*.py \
    && python -B -m unittest discover -s /tests -v

CMD ["mitmdump", "--mode", "transparent", "--listen-host", "0.0.0.0", "--listen-port", "8080", "--set", "confdir=/home/mitmproxy/.mitmproxy", "--set", "flow_detail=0", "-s", "/app/app/main.py"]
