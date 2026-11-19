class_name Piping
extends Node3D
## Refrigerant piping from the nearest outdoor unit to every indoor AC: a liquid line and a gas line per circuit.
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
var traced := ""  # AC id whose circuit is traced; "" = none
var _beads_liquid: Beads
var _beads_gas: Beads
var odu_id := ""


func _ready() -> void:
	Bus.live_updated.connect(refresh)


func build() -> void:
	var odus: Array = Store.devices.filter(func(d): return d.type == "odu")
	if odus.is_empty():
		return
	odu_id = odus[0].id
	_beads_liquid = Beads.new().setup(LIQUID, 0.03)
	_beads_gas = Beads.new().setup(GAS, 0.03)
	add_child(_beads_liquid)
	add_child(_beads_gas)
	var acs: Array = Store.devices.filter(func(d): return d.type == "ac")
	var base := PlanGeo.wall_segments(Store.rooms)
	# Each indoor unit is piped to the nearest outdoor unit (one circuit per indoor unit).
	var entries := {}
	var joins: Array = []
	for o in odus:
		entries[o.id] = PlanGeo.nearest_on_walls(base, Vector2(o.position[0], o.position[2]))
		joins.append(entries[o.id])
	var ac_join := {}
	for d in acs:
		ac_join[d.id] = PlanGeo.nearest_on_walls(base, Vector2(d.position[0], d.position[2]))
		joins.append(ac_join[d.id])
	var segs := PlanGeo.wall_segments(Store.rooms, joins)
	var lane := {}
	for d in acs:
		var a2 := Vector2(d.position[0], d.position[2])
		var odu: Dictionary = odus[0]
		for o in odus:
			if a2.distance_to(Vector2(o.position[0], o.position[2])) < a2.distance_to(Vector2(odu.position[0], odu.position[2])):
				odu = o
		var o2 := Vector2(odu.position[0], odu.position[2])
		var entry: Vector2 = entries[odu.id]
		var j2: Vector2 = ac_join[d.id]
		var route: Array = PlanGeo.path_along(segs, entry, j2)
		if route.is_empty():
			route = [entry, Vector2(j2.x, entry.y), j2]  # disconnected plan: fall back to an L-shaped run
		var i: int = lane.get(odu.id, 0)
		lane[odu.id] = i + 1
		var ac := Vector3(d.position[0], d.position[1], d.position[2])
		var run := {"length": 0.0, "odu": odu.id}
		for side in ["liquid", "gas"]:
			var y := CEILING + LANE * i + (0.045 if side == "gas" else 0.0)
			var pts: Array = [Vector3(o2.x, 0.45, o2.y), Vector3(o2.x, y, o2.y)]
			for p in route:
				pts.append(Vector3(p.x, y, p.y))
			pts.append(Vector3(ac.x, ac.y + 0.14, ac.z))
			var mats := Tube.build(self, pts, GAS if side == "gas" else LIQUID, RADIUS)
			run[side] = mats
			run[side + "_bead"] = (_beads_gas if side == "gas" else _beads_liquid).add_line(pts, 0.6)
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
	for id in _runs:
		var o: Dictionary = Store.live.get(_runs[id].odu, {})
		var hz: float = float(o.get("hz", 58.0))
		var dis: float = float(o.get("dis", 74.0))
		var a: Dictionary = Store.live.get(id, {})
		var on := bool(a.get("on", true))
		var speed := 0.6 * hz / 58.0 * (1.0 if on else 0.0)
		var sh: float = float(a.get("sh", 5.0))
		var trace_k := 1.0 if traced == "" else (2.2 if id == traced else 0.25)
		var liquid_glow := clampf(1.0 - (sh - 5.0) / 12.0, 0.3, 1.0) * trace_k
		var gas_glow := clampf(dis / 74.0, 0.5, 1.8) * trace_k
		_beads_liquid.set_speed(_runs[id].liquid_bead, speed)
		_beads_gas.set_speed(_runs[id].gas_bead, -speed)  # gas returns to the outdoor unit
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
