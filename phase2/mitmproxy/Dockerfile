FROM mitmproxy/mitmproxy:12.2.3

COPY phase2/mitmproxy/addons/observe.py /addons/observe.py

RUN python -m py_compile /addons/observe.py \
    && python /addons/observe.py
