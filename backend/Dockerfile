FROM python:3.12-slim

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY scripts/install-v8unpack.sh /tmp/install-v8unpack.sh
RUN sed -i "s/\r$//" /tmp/install-v8unpack.sh \
    && chmod +x /tmp/install-v8unpack.sh \
    && /tmp/install-v8unpack.sh \
    && rm -f /tmp/install-v8unpack.sh

COPY app ./app
COPY src/main/resources/application.yml ./src/main/resources/application.yml

VOLUME ["/work"]
EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080"]
