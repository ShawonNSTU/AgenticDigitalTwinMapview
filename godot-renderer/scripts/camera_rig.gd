class_name CameraRig
extends Node3D
## Orbit camera: left-drag orbit, right/middle-drag pan, wheel zoom, one-finger orbit and pinch on touch.
## fly_to() animates target, distance and angles together.

var target := Vector3(-2.5, 0, -3.5)
var yaw := deg_to_rad(-30.0)
var pitch := deg_to_rad(-52.0)
var distance := 19.0
var cam: Camera3D

var _home := {}
var _drag := 0
var _tw: Tween
var _touches := {}
var _pinch := 0.0

## Pixels moved during the current/last mouse drag; device clicks ignore drags.
static var drag_px := 0.0


func _ready() -> void:
	cam = Camera3D.new()
	cam.fov = 45
	cam.near = 0.05
	cam.far = 200
	add_child(cam)
	_home = {"target": target, "yaw": yaw, "pitch": pitch, "distance": distance}
	_apply()


func _apply() -> void:
	pitch = clampf(pitch, deg_to_rad(-88.0), deg_to_rad(-6.0))
	distance = clampf(distance, 0.8, 45.0)
	var dir := Vector3(cos(pitch) * sin(yaw), -sin(pitch), cos(pitch) * cos(yaw))
	cam.global_position = target + dir * distance
	cam.look_at(target, Vector3.UP)


func fly_to(new_target: Vector3, new_distance: float, new_pitch := NAN, new_yaw := NAN, secs := 0.9) -> void:
	if _tw:
		_tw.kill()
	_tw = create_tween().set_parallel().set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN_OUT)
	_tw.tween_property(self, "target", new_target, secs)
	_tw.tween_property(self, "distance", new_distance, secs)
	if not is_nan(new_pitch):
		_tw.tween_property(self, "pitch", new_pitch, secs)
	if not is_nan(new_yaw):
		# shortest way round
		var y := yaw + wrapf(new_yaw - yaw, -PI, PI)
		_tw.tween_property(self, "yaw", y, secs)
	_tw.tween_method(func(_v): _apply(), 0.0, 1.0, secs)


func reset() -> void:
	fly_to(_home.target, _home.distance, _home.pitch, _home.yaw)


func _unhandled_input(e: InputEvent) -> void:
	if e is InputEventMouseButton:
		if e.button_index == MOUSE_BUTTON_WHEEL_UP and e.pressed:
			distance *= 0.9
		elif e.button_index == MOUSE_BUTTON_WHEEL_DOWN and e.pressed:
			distance *= 1.1
		elif e.pressed:
			_drag = e.button_index
			drag_px = 0.0
		else:
			_drag = 0
		_apply()
	elif e is InputEventMouseMotion and _drag != 0:
		drag_px += e.relative.length()
		if _drag == MOUSE_BUTTON_LEFT:
			_orbit(e.relative)
		else:
			_pan(e.relative)
	elif e is InputEventScreenTouch:
		if e.pressed:
			_touches[e.index] = e.position
		else:
			_touches.erase(e.index)
		_pinch = 0.0
	elif e is InputEventScreenDrag:
		_touches[e.index] = e.position
		if _touches.size() == 1:
			_orbit(e.relative)
		elif _touches.size() == 2:
			var p: Array = _touches.values()
			var d: float = (p[0] as Vector2).distance_to(p[1])
			if _pinch > 0.0:
				distance *= _pinch / d
				_apply()
			_pinch = d


func _orbit(rel: Vector2) -> void:
	if _tw and _tw.is_running():
		_tw.kill()
	yaw -= rel.x * 0.006
	pitch -= rel.y * 0.006
	_apply()


func _pan(rel: Vector2) -> void:
	var right := cam.global_basis.x
	var fwd := Vector3(-sin(yaw), 0, -cos(yaw))
	target += (-right * rel.x + fwd * rel.y) * distance * 0.0015
	_apply()
