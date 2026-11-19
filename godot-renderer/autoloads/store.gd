extends Node
## Static floor data (res://data/*.json) plus live state polled from the simulated platform
## served by the Next.js app (GET /api/floor, /api/devices/:id).

const HEALTH_COLORS := {"ok": Color("3fb950"), "watch": Color("d29922"), "fault": Color("f85149")}

var rooms: Array = []
var devices: Array = []
var by_id: Dictionary = {}
var types: Dictionary = {}
var outdoor_pad: Dictionary = {}
var wall_height := 1.15

var t := 10.0
var scenario := "normal"
var health: Dictionary = {}       # id -> "ok" | "watch" | "fault"
var open_id := ""                 # device whose internals are open
var platform_url := "http://localhost:3000"

var _floor_req: HTTPRequest
var _dev_req: HTTPRequest
var _busy_floor := false
var _busy_dev := false


func _ready() -> void:
	var b: Dictionary = _load("res://data/building.json")
	rooms = b.get("rooms", [])
	outdoor_pad = b.get("outdoorPad", {})
	wall_height = b.get("wallHeight", 1.15)
	devices = _load("res://data/devices.json")
	types = _load("res://data/device_types.json")
	for d in devices:
		by_id[d.id] = d
		health[d.id] = "ok"
	var env_url := OS.get_environment("PLATFORM_URL")
	if env_url != "":
		platform_url = env_url
	if OS.has_feature("web"):
		var origin = JavaScriptBridge.eval("window.location.origin", true)
		if origin is String and origin != "":
			platform_url = origin
	_floor_req = HTTPRequest.new()
	_dev_req = HTTPRequest.new()
	add_child(_floor_req)
	add_child(_dev_req)
	_floor_req.request_completed.connect(_on_floor)
	_dev_req.request_completed.connect(_on_device)
	var timer := Timer.new()
	timer.wait_time = 1.0
	timer.autostart = true
	timer.timeout.connect(_poll)
	add_child(timer)
	Bus.open_requested.connect(func(id, _p): open_id = id; _poll_device())
	Bus.close_requested.connect(func(): open_id = "")


func _load(path: String) -> Variant:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		push_error("Missing %s" % path)
		return {}
	return JSON.parse_string(f.get_as_text())


func color_for(h: String) -> Color:
	return HEALTH_COLORS.get(h, HEALTH_COLORS.ok)


func room(key: String) -> Dictionary:
	for r in rooms:
		if r.key == key:
			return r
	return {}


func _poll() -> void:
	if not _busy_floor:
		_busy_floor = true
		_floor_req.request(platform_url + "/api/floor")
	_poll_device()


func _poll_device() -> void:
	if open_id != "" and not _busy_dev:
		_busy_dev = true
		_dev_req.request(platform_url + "/api/devices/" + open_id)


func _on_floor(result: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	_busy_floor = false
	if result != HTTPRequest.RESULT_SUCCESS or code != 200:
		return  # platform offline: keep showing the static floor
	var data = JSON.parse_string(body.get_string_from_utf8())
	if typeof(data) != TYPE_DICTIONARY:
		return
	set_time(float(data.get("time", t)))
	set_scenario(str(data.get("scenario", scenario)))
	for d in data.get("devices", []):
		if health.get(d.id, "") != d.health:
			health[d.id] = d.health
			Bus.health_changed.emit(d.id, d.health)


func _on_device(result: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	_busy_dev = false
	if result != HTTPRequest.RESULT_SUCCESS or code != 200:
		return
	var data = JSON.parse_string(body.get_string_from_utf8())
	if typeof(data) == TYPE_DICTIONARY and data.get("id", "") == open_id:
		Bus.device_data.emit(open_id, data)


func set_time(v: float) -> void:
	if absf(v - t) > 0.0001:
		t = v
		Bus.time_changed.emit(t)


func set_scenario(key: String) -> void:
	if key != scenario:
		scenario = key
		Bus.scenario_changed.emit(key)
