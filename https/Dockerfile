FROM mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f

ENV PYTHONPATH=/opt/https

WORKDIR /opt/https

COPY https/core /opt/https/core
COPY https/strategies /opt/https/strategies
COPY https/config /opt/https/config
COPY https/addons /opt/https/addons
COPY https/tests /opt/https/tests

RUN python -m py_compile       /opt/https/core/context.py       /opt/https/core/registry.py       /opt/https/strategies/base.py       /opt/https/strategies/instagram.py       /opt/https/addons/main.py     && python -m unittest discover -s /opt/https/tests -p 'test_*.py'
