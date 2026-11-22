"""Plain commands on one named device are understood without the model; anything else is left to it."""
from dataclasses import replace

import pytest

from app.config import Settings
from app.core.fastlane import direct
from app.core.llm import OllamaLLM
from app.normalize import build_devices
from tests.conftest import sample_request

DEVS = build_devices(sample_request())


@pytest.mark.parametrize("text,device,action,value", [
    ("turn on Light 1", "Light 1", "switch.on", ""),
    ("Light 2 off", "Light 2", "switch.off", ""),
    ("please switch off the Desk Lamp", "Desk Lamp", "switch.off", ""),
    ("turn the Desk Lamp on", "Desk Lamp", "switch.on", ""),
    ("dim Light 3 to 30%", "Light 3", "switchLevel.setLevel", "30"),
    ("set Light 4 to 50", "Light 4", "switchLevel.setLevel", "50"),
    ("open the Aqara Roller Shade Controller", "Aqara Roller Shade Controller", "windowShade.open", ""),
    ("close Dining Shade Controller", "Dining Shade Controller", "windowShade.close", ""),
    ("set Aqara Roller Shade Controller to 40%", "Aqara Roller Shade Controller", "windowShadeLevel.setShadeLevel", "40"),
])
def test_plain_commands(text, device, action, value):
    r = direct(text, DEVS)
    assert r is not None and (r.device.name, r.action_id, r.value) == (device, action, value)


@pytest.mark.parametrize("text", [
    "turn on Light 1 and Light 2", "make Light 1 a bit brighter", "turn on the light", "is Light 1 on?",
    "turn off all lights", "Light 1 to 140%", "turn on Light 1 if it's dark", "I'm cold", "turn up Light 1",
    "turn on Light 1 in 10 minutes", "don't turn on Light 1", "unlock the door",
])
def test_everything_else_goes_to_the_model(text):
    assert direct(text, DEVS) is None


def test_fast_model_only_for_closed_choice_steps():
    s = replace(Settings(), ollama_model="big", ollama_fast_model="small")
    llm = OllamaLLM(s)
    assert llm._model_for("router") == "small" and llm._model_for("action_select") == "small"
    assert llm._model_for("smart_control") == "big" and llm._model_for("knowledge") == "big"
    assert OllamaLLM(replace(s, ollama_fast_model=""))._model_for("router") == "big"
