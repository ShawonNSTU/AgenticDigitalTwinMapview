class_name Piping
extends Node3D
## Refrigerant piping from the outdoor unit to every indoor AC: a liquid line and a gas line per circuit.
## Routing: up from the outdoor unit to the ceiling void, to the nearest wall, then the shortest way along
## the walls (never across a room) to the wall the AC hangs on, then down into the AC. Circuits sharing a
## wall run are stacked like a pipe rack.
##
## Live data (from /api/floor, Store.live) drives the animation:
##   flow speed  = 0.6 m/s × compressor Hz / 58 (nominal), × 0 if the AC is off
##   liquid line = brightness falls as the AC's superheat rises above 5 K (starved coil, e.g. a leak)
##   gas line    = brightness follows discharge temperature (74 °C nominal)
## Colours: liquid #4c8dff, gas #ff8a3d. trace() brightens one circuit and dims the rest.

const CEILING := 2.55
const LANE := 0.09
const RADIUS := 0.022
const LIQUID := Color("4c8dff")
const GAS := Color("ff8a3d")

var _runs := {}  # ac id -> {"liquid": [mats], "gas": [mats], "length": metres}
var traced := ""
var odu_id := ""


func _ready() -> void:
	Bus.live_updated.connect(refresh)


func build() -> void:
	var odu := _first("odu")
	if odu.is_empty():
		return
	odu_id = odu.id
	var o2 := Vector2(odu.position[0], odu.position[2])
	var acs: Array = Store.devices.filter(func(d): return d.type == "ac")
	# Wall network, split at the points where pipes join it.
	var base := PlanGeo.wall_segments(Store.rooms)
	var entry := PlanGeo.nearest_on_walls(base, o2)
	var joins: Array = [entry]
	for d in acs:
		joins.append(PlanGeo.nearest_on_walls(base, Vector2(d.position[0], d.position[2])))
	var segs := PlanGeo.wall_segments(Store.rooms, joins)
	for i in acs.size():
		var d: Dictionary = acs[i]
		var a2: Vector2 = joins[i + 1]
		var route: Array = PlanGeo.path_along(segs, entry, a2)
		if route.is_empty():
			route = [entry, Vector2(a2.x, entry.y), a2]  # disconnected plan: fall back to an L-shaped run
		var ac := Vector3(d.position[0], d.position[1], d.position[2])
		var run := {"length": 0.0}
		for side in ["liquid", "gas"]:
			var y := CEILING + LANE * i + (0.045 if side == "gas" else 0.0)
			var pts: Array = [Vector3(o2.x, 0.45, o2.y), Vector3(o2.x, y, o2.y)]
			for p in route:
				pts.append(Vector3(p.x, y, p.y))
			pts.append(Vector3(ac.x, ac.y + 0.14, ac.z))
			var mats := Tube.build(self, pts, GAS if side == "gas" else LIQUID, RADIUS)
			for m in mats:
				m.set_meta("reverse", side == "gas")  # liquid flows to the AC, gas returns to the outdoor unit
			run[side] = mats
			if side == "liquid":
				for k in pts.size() - 1:
					run.length += (pts[k] as Vector3).distance_to(pts[k + 1])
		_runs[d.id] = run
	refresh()


func _first(type: String) -> Dictionary:
	for d in Store.devices:
		if d.type == type:
			return d
	return {}


func refresh() -> void:
	var o: Dictionary = Store.live.get(odu_id, {})
	var hz: float = float(o.get("hz", 58.0))
	var dis: float = float(o.get("dis", 74.0))
	for id in _runs:
		var a: Dictionary = Store.live.get(id, {})
		var on := bool(a.get("on", true))
		var speed := 0.6 * hz / 58.0 * (1.0 if on else 0.0)
		var sh: float = float(a.get("sh", 5.0))
		var trace_k := 1.0 if traced == "" else (2.2 if id == traced else 0.25)
		var liquid_glow := clampf(1.0 - (sh - 5.0) / 12.0, 0.3, 1.0) * trace_k
		var gas_glow := clampf(dis / 74.0, 0.5, 1.8) * trace_k
		for m in _runs[id].liquid:
			m.set_shader_parameter("speed", speed)
			m.set_shader_parameter("glow", liquid_glow)
		for m in _runs[id].gas:
			m.set_shader_parameter("speed", -speed)
			m.set_shader_parameter("glow", gas_glow)


func trace(from_id: String) -> void:
	traced = from_id if _runs.has(from_id) else ""
	refresh()


## Pipe run length (one line) per AC, for the side panel or the agent.
func lengths() -> Dictionary:
	var out := {}
	for id in _runs:
		out[id] = snappedf(_runs[id].length, 0.1)
	return out
