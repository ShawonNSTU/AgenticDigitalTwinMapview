"""Entry point: `python main.py` or `uvicorn main:app --host 0.0.0.0 --port 8100`."""
import uvicorn

from app.api import create_app
from app.config import settings

app = create_app(settings)

if __name__ == "__main__":
    uvicorn.run(app, host=settings.host, port=settings.port)
