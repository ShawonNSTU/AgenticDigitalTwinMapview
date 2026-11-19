extends Node
## Static floor data (res://data/*.json) plus live state polled from the simulated platform
## served by the Next.js app (GET /api/floor, /api/devices/:id).

const HEALTH_COLORS := {"ok": Color("3fb950"), "watch": Color("d29922"), "fault": Color("f85149")}

var rooms: Array = []
var furniture: Array = []   # interiors from the plan: {kind, x, z, w, d, rot}
var devices: Array = []
var by_id: Dictionary = {}
var types: Dictionary = {}
var outdoor_pad: Dictionary = {}
var wall_height := 1.15

var t := 10.0
var scenario := "normal"
var health: Dictionary = {}       # id -> "ok" | "watch" | "fault"
var live: Dictionary = {}         # id -> live readings for ACs and the outdoor unit (refrigerant circuits)
var open_id := ""                 # device whose internals are open
var platform_url := "http://localhost:3000"
var layout_version := 0           # 0 = bundled sample home (same as the platform's sample)
var plan_texture: Texture2D       # uploaded floor plan image, or null
var plan_bounds := Rect2()        # x/z extent of the plan image in metres

var _floor_req: HTTPRequest
var _dev_req: HTTPRequest
var _building_req: HTTPRequest
var _plan_req: HTTPRequest
var _busy_building := false
var _pending_layout: Dictionary = {}
var _busy_floor := false
var _announced := false  # first layout announced to the scene
var _fails := 0
signal platform_unreachable  # the first /api/floor request failed: run on the bundled sample
var _busy_dev := false


func _ready() -> void:
	var b: Dictionary = _load("res://data/building.json")
	types = _load("res://data/device_types.json")
	_apply_layout(b.get("rooms", []), _load("res://data/devices.json"), b.get("outdoorPad", {}), b.get("wallHeight", 1.15))
	var env_url := OS.get_environment("PLATFORM_URL")
	if env_url != "":
		platform_url = env_url
	if OS.has_feature("web"):
		var origin = JavaScriptBridge.eval("window.location.origin", true)
		if origin is String and origin != "":
			platform_url = origin
	_floor_req = HTTPRequest.new()
	_dev_req = HTTPRequest.new()
	_building_req = HTTPRequest.new()
	_plan_req = HTTPRequest.new()
	for r in [_floor_req, _dev_req, _building_req, _plan_req]:
		# In the browser, fetch() already decompresses gzip responses; asking Godot to do it again fails.
		r.accept_gzip = not OS.has_feature("web")
		add_child(r)
	_building_req.request_completed.connect(_on_building)
	_plan_req.request_completed.connect(_on_plan)
	_floor_req.request_completed.connect(_on_floor)
	_dev_req.request_completed.connect(_on_device)
	var timer := Timer.new()
	timer.wait_time = 1.0
	timer.autostart = true
	timer.timeout.connect(_poll)
	add_child(timer)
	_poll.call_deferred()  # ask for the current layout right away, not after the first second
	Bus.open_requested.connect(func(id, _p): open_id = id; _poll_device(true))
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


func _poll_device(restart := false) -> void:
	if restart and _busy_dev:
		_dev_req.cancel_request()  # a different device was opened; don't wait for the old answer
		_busy_dev = false
	if open_id != "" and not _busy_dev:
		_busy_dev = true
		_dev_req.request(platform_url + "/api/devices/" + open_id)


func _on_floor(result: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	_busy_floor = false
	if result != HTTPRequest.RESULT_SUCCESS or code != 200:
		_fails += 1
		if not _announced and _fails == 3:  # three failures in a row (the first request in a browser can fail once)
			platform_unreachable.emit()
		return  # platform offline: keep showing the static floor
	_fails = 0
	var data = JSON.parse_string(body.get_string_from_utf8())
	if typeof(data) != TYPE_DICTIONARY:
		return
	if _busy_building:
		return  # a new layout (and its plan image) is still downloading
	if int(data.get("layoutVersion", 0)) != layout_version:
		_busy_building = true
		_building_req.request(platform_url + "/api/building")
		return
	if not _announced:
		_announced = true  # the platform runs the same sample home we bundle: build it now
		Bus.layout_changed.emit()
	set_time(float(data.get("time", t)))
	set_scenario(str(data.get("scenario", scenario)))
	for d in data.get("devices", []):
		if d.has("live"):
			live[d.id] = d.live
		if health.get(d.id, "") != d.health:
			health[d.id] = d.health
			Bus.health_changed.emit(d.id, d.health)
	Bus.live_updated.emit()


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


func _apply_layout(new_rooms: Array, new_devices: Array, pad: Dictionary, wall_h: float) -> void:
	rooms = new_rooms
	devices = new_devices
	outdoor_pad = pad
	wall_height = wall_h
	by_id.clear()
	health.clear()
	live.clear()
	for d in devices:
		by_id[d.id] = d
		health[d.id] = "ok"
	open_id = ""


func _on_building(result: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	if result != HTTPRequest.RESULT_SUCCESS or code != 200:
		_busy_building = false
		return
	var b = JSON.parse_string(body.get_string_from_utf8())
	if typeof(b) != TYPE_DICTIONARY:
		_busy_building = false
		return
	_pending_layout = b
	var plan = b.get("plan")
	if plan is Dictionary:
		_plan_req.request(platform_url + str(plan.url))  # finish once the image arrives
	else:
		_finish_layout(null)


func _on_plan(result: int, code: int, _h: PackedStringArray, body: PackedByteArray) -> void:
	var tex: Texture2D = null
	if result == HTTPRequest.RESULT_SUCCESS and code == 200:
		var img := Image.new()
		var err := ERR_FILE_UNRECOGNIZED
		if body.size() > 8 and body[0] == 0x89 and body[1] == 0x50:
			err = img.load_png_from_buffer(body)
		elif body.size() > 3 and body[0] == 0xFF and body[1] == 0xD8:
			err = img.load_jpg_from_buffer(body)
		else:
			err = img.load_webp_from_buffer(body)
		if err == OK:
			img.generate_mipmaps()
			tex = ImageTexture.create_from_image(img)
	_finish_layout(tex)


func _finish_layout(tex: Texture2D) -> void:
	var b := _pending_layout
	_pending_layout = {}
	_busy_building = false
	plan_texture = tex
	var plan = b.get("plan")
	plan_bounds = Rect2(plan.x0, plan.z0, plan.x1 - plan.x0, plan.z1 - plan.z0) if plan is Dictionary else Rect2()
	furniture = b.get("furniture", [])
	_apply_layout(b.get("rooms", []), b.get("devices", []), b.get("outdoorPad", {}), float(b.get("wallHeight", wall_height)))
	layout_version = int(b.get("version", 0))
	_announced = true
	Bus.layout_changed.emit()


## Bounds of all rooms in metres (x, z), for framing the camera.
func floor_rect() -> Rect2:
	if rooms.is_empty():
		return Rect2(-5, -5, 10, 10)
	var r := Rect2(rooms[0].x[0], rooms[0].z[0], 0, 0)
	for room in rooms:
		r = r.expand(Vector2(room.x[0], room.z[0])).expand(Vector2(room.x[1], room.z[1]))
	return r
