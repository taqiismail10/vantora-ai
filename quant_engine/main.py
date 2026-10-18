"""FastAPI surface for the Vantora quantitative engine (127.0.0.1:8000)."""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .forecaster import forecast
from .optimizer import optimize
from .schemas import (
    ForecastResultOutput,
    OptimizationResultOutput,
    SmeFinancialStateInput,
)

app = FastAPI(title="Vantora Quant Engine", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok", "service": "vantora-quant-engine"}


@app.post("/api/quant/forecast", response_model=ForecastResultOutput)
def run_forecast(state: SmeFinancialStateInput) -> ForecastResultOutput:
    return forecast(state)


@app.post("/api/quant/optimize", response_model=OptimizationResultOutput)
def run_optimize(state: SmeFinancialStateInput) -> OptimizationResultOutput:
    # Reuse the one forecast the optimizer needs instead of simulating twice.
    return optimize(state, forecast(state))
