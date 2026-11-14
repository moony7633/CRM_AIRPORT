import math

def calibrate(p1, p2):
    """
    p1, p2: (x_px, y_px, lat, lon)
    Возвращает geo-словарь для airport_demo.json.
    """
    x1, y1, lat1, lon1 = p1
    x2, y2, lat2, lon2 = p2

    # Реальные метры от точки 1 к точке 2
    dlat_m = (lat2 - lat1) * 111_320.0
    dlon_m = (lon2 - lon1) * 111_320.0 * math.cos(math.radians(lat1))

    # Пиксельный вектор
    dx_px = x2 - x1
    dy_px = y2 - y1                      # y в пикселях — вниз
    # Переводим в «карту с y-вверх» для удобства
    dy_up = -dy_px

    # Масштаб (м/px) — по гипотенузе
    scale = math.hypot(dlat_m, dlon_m) / math.hypot(dx_px, dy_px)

    # Угол поворота: в реальности направление (dlon_m, dlat_m),
    # на карте — (dx_px, dy_up). Поворот — разность углов.
    a_real = math.atan2(dlat_m, dlon_m)   # y=lat (север), x=lon (восток)
    a_map  = math.atan2(dy_up, dx_px)
    rot_deg = math.degrees(a_real - a_map)

    # Найдём lat0/lon0 для пикселя (0,0):
    # 1. Сдвигаем пиксель 1 в (0,0) с учётом поворота
    c, s = math.cos(math.radians(rot_deg)), math.sin(math.radians(rot_deg))
    # Координата пикселя 1 относительно (0,0) в «карте с y-вверх»:
    vx, vy = x1, -y1
    # Повёрнутая карта → реальные метры
    rx = (c * vx - s * vy) * scale
    ry = (s * vx + c * vy) * scale
    # lat0/lon0 — такая точка, что от (0,0) до точки 1 = (rx, ry)
    lat0 = lat1 - ry / 111_320.0
    lon0 = lon1 - rx / (111_320.0 * math.cos(math.radians(lat1)))

    return {
        "lat0": round(lat0, 6),
        "lon0": round(lon0, 6),
        "scale": round(scale, 4),
        "rot_deg": round(rot_deg, 3),
    }


if __name__ == "__main__":
    # p1: ВПП 06L торец, p2: ВПП 06C торец
    geo = calibrate(
        (150,  975, 55.9808, 37.3183),
        (3768, 2207, 55.9708, 37.3967),
    )
    print(geo)

    # Проверка: обратная формула
    def xy_to_gps(x, y, g):
        a = math.radians(g["rot_deg"])
        xr = x * math.cos(a) - (-y) * math.sin(a)
        yr = x * math.sin(a) + (-y) * math.cos(a)
        lat = g["lat0"] + yr * g["scale"] / 111_320.0
        lon = g["lon0"] + xr * g["scale"] / (111_320.0 * math.cos(math.radians(g["lat0"])))
        return round(lat, 6), round(lon, 6)

    print("06L →", xy_to_gps(150, 975, geo), "ожидаем 55.9808, 37.3183")
    print("06C →", xy_to_gps(3768, 2207, geo), "ожидаем 55.9708, 37.3967")
    print("S1  →", xy_to_gps(4488, 2951, geo), "стоянка ВС-01")
