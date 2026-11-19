from app.search import search


def ids(res):
    return {d["id"] for d in res["devices"]}


def test_type_synonyms(floor):
    res = search("show me all the air conditioners", floor)
    assert res["count"] > 0 and all(d.startswith("AC-") for d in ids(res))


def test_health_problem(floor):
    assert ids(search("which ACs have a problem?", floor)) == {"AC-04", "AC-05"}
    assert ids(search("faulty aircon", floor)) == {"AC-05"}


def test_room(floor):
    res = search("lights in the kitchen", floor)
    assert res["count"] > 0
    assert all(d["room"] == "kitchen" and d["id"].startswith("LT") for d in res["devices"])


def test_bedroom_does_not_match_primary_suite(floor):
    res = search("devices in the bedroom", floor)
    assert res["count"] > 0 and {d["room"] for d in res["devices"]} == {"bedroom"}


def test_explicit_id(floor):
    assert ids(search("open ac-05", floor)) == {"AC-05"}


def test_explicit_filters_override_words(floor):
    res = search("anything", floor, type="lock")
    assert res["count"] > 0 and all(d["label"].lower().endswith("lock") for d in res["devices"])


def test_no_match(floor):
    assert search("unicorn stable", floor)["count"] == 0


def test_plan_style_camera_ids(floor):
    floor["devices"].append({"id": "2FX1C07", "type": "camera", "label": "Camera", "room": "kitchen", "name": "Camera 2FX1C07", "health": "ok"})
    assert ids(search("where is camera 2fx1c07?", floor)) == {"2FX1C07"}


def test_room_base_name_and_nickname(floor):
    floor["rooms"] += [{"key": "training-room-403-sajek", "name": "Training Room 403 (Sajek)"}, {"key": "training-room-402-saint-martin", "name": "Training Room 402 (Saint Martin)"}]
    floor["devices"] += [{"id": "CAM-A", "type": "camera", "label": "Camera", "room": "training-room-403-sajek", "name": "a", "health": "ok"},
                         {"id": "CAM-B", "type": "camera", "label": "Camera", "room": "training-room-402-saint-martin", "name": "b", "health": "ok"}]
    assert ids(search("cameras in the training room", floor)) == {"CAM-A", "CAM-B"}
    assert ids(search("camera in saint martin", floor)) == {"CAM-B"}
