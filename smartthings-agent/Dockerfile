FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
ENV PORT=8100 HOST=0.0.0.0
EXPOSE 8100
HEALTHCHECK CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8100/health')"
CMD ["python", "main.py"]
