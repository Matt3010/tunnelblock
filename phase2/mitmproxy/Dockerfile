FROM mitmproxy/mitmproxy:12.2.3@sha256:00b77b5d8804c8ad18cb6caefbf9d5849e895e8986c5ce011f4ae30f4385962f

COPY phase2/mitmproxy/protobuf_scan.py /addons/protobuf_scan.py
COPY phase2/mitmproxy/addons/observe.py /addons/observe.py

RUN python -m py_compile /addons/protobuf_scan.py /addons/observe.py \
    && python /addons/protobuf_scan.py \
    && python /addons/observe.py
