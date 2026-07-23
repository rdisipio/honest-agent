import asyncio
from datetime import date

import httpx

NHL_API = "https://api-web.nhle.com/v1"

# Free-text team name/nickname -> official 3-letter abbrev. NHL's API has no
# search-by-name endpoint, so the model's tool-call arguments (whatever it
# names the team) need resolving locally before hitting the schedule/boxscore
# endpoints, which are abbrev-keyed only.
TEAM_ABBREVS = {
    "anaheim ducks": "ANA", "ducks": "ANA",
    "utah hockey club": "UTA", "utah mammoth": "UTA", "utah": "UTA",
    "boston bruins": "BOS", "bruins": "BOS",
    "buffalo sabres": "BUF", "sabres": "BUF",
    "calgary flames": "CGY", "flames": "CGY",
    "carolina hurricanes": "CAR", "hurricanes": "CAR", "canes": "CAR",
    "chicago blackhawks": "CHI", "blackhawks": "CHI", "hawks": "CHI",
    "colorado avalanche": "COL", "avalanche": "COL", "avs": "COL",
    "columbus blue jackets": "CBJ", "blue jackets": "CBJ", "jackets": "CBJ",
    "dallas stars": "DAL", "stars": "DAL",
    "detroit red wings": "DET", "red wings": "DET", "wings": "DET",
    "edmonton oilers": "EDM", "oilers": "EDM",
    "florida panthers": "FLA", "panthers": "FLA",
    "los angeles kings": "LAK", "la kings": "LAK", "kings": "LAK",
    "minnesota wild": "MIN", "wild": "MIN",
    "montreal canadiens": "MTL", "montréal canadiens": "MTL",
    "canadiens": "MTL", "habs": "MTL",
    "nashville predators": "NSH", "predators": "NSH", "preds": "NSH",
    "new jersey devils": "NJD", "devils": "NJD",
    "new york islanders": "NYI", "islanders": "NYI", "isles": "NYI",
    "new york rangers": "NYR", "rangers": "NYR",
    "ottawa senators": "OTT", "senators": "OTT", "sens": "OTT",
    "philadelphia flyers": "PHI", "flyers": "PHI",
    "pittsburgh penguins": "PIT", "penguins": "PIT", "pens": "PIT",
    "san jose sharks": "SJS", "sharks": "SJS",
    "seattle kraken": "SEA", "kraken": "SEA",
    "st louis blues": "STL", "st. louis blues": "STL", "blues": "STL",
    "tampa bay lightning": "TBL", "lightning": "TBL", "bolts": "TBL",
    "toronto maple leafs": "TOR", "maple leafs": "TOR", "leafs": "TOR",
    "vancouver canucks": "VAN", "canucks": "VAN",
    "vegas golden knights": "VGK", "golden knights": "VGK", "knights": "VGK",
    "washington capitals": "WSH", "capitals": "WSH", "caps": "WSH",
    "winnipeg jets": "WPG", "jets": "WPG",
}


def resolve_team(name: str) -> str | None:
    key = name.strip().lower()
    if key.upper() in TEAM_ABBREVS.values():
        return key.upper()
    if key in TEAM_ABBREVS:
        return TEAM_ABBREVS[key]
    for alias, abbrev in TEAM_ABBREVS.items():
        if key in alias or alias in key:
            return abbrev
    return None


def _goalie_summary(box: dict, side: str) -> list[dict]:
    goalies = box["playerByGameStats"][side]["goalies"]
    return [
        {
            "name": g["name"]["default"],
            "starter": g.get("starter", False),
            "decision": g.get("decision"),
            "saves": g.get("saves"),
            "shots_against": g.get("shotsAgainst"),
        }
        for g in goalies
        if g.get("toi", "00:00") != "00:00"
    ]


def _top_scorers(box: dict, side: str, limit: int = 3) -> list[dict]:
    skaters = box["playerByGameStats"][side]["forwards"] + box["playerByGameStats"][side]["defense"]
    scored = [p for p in skaters if p.get("points", 0) > 0]
    ranked = sorted(scored, key=lambda p: (p["points"], p["goals"]), reverse=True)
    return [
        {
            "name": p["name"]["default"],
            "position": p["position"],
            "goals": p["goals"],
            "assists": p["assists"],
            "points": p["points"],
        }
        for p in ranked[:limit]
    ]


async def fetch_game_details(team1: str, team2: str, date: str) -> dict:
    abbrev1 = resolve_team(team1)
    abbrev2 = resolve_team(team2)
    if not abbrev1:
        return {"error": f"Unrecognized team: {team1}"}
    if not abbrev2:
        return {"error": f"Unrecognized team: {team2}"}

    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        sched_res = await client.get(f"{NHL_API}/schedule/{date}")
        if sched_res.status_code != 200:
            return {"error": f"Could not fetch schedule for {date}."}
        sched = sched_res.json()

        game_week = sched.get("gameWeek") or []
        games = game_week[0]["games"] if game_week else []
        game = next(
            (
                g for g in games
                if {g["awayTeam"]["abbrev"], g["homeTeam"]["abbrev"]} == {abbrev1, abbrev2}
            ),
            None,
        )
        if not game:
            return {"error": f"No {abbrev1}-{abbrev2} game found on {date}."}

        box_res = await client.get(f"{NHL_API}/gamecenter/{game['id']}/boxscore")
        if box_res.status_code != 200:
            return {"error": "Found the game but could not fetch its boxscore."}
        box = box_res.json()

    return {
        "date": date,
        "away_team": box["awayTeam"]["commonName"]["default"],
        "home_team": box["homeTeam"]["commonName"]["default"],
        "away_score": box["awayTeam"]["score"],
        "home_score": box["homeTeam"]["score"],
        "away_goalies": _goalie_summary(box, "awayTeam"),
        "home_goalies": _goalie_summary(box, "homeTeam"),
        "away_top_scorers": _top_scorers(box, "awayTeam"),
        "home_top_scorers": _top_scorers(box, "homeTeam"),
    }


def _age(birth_date: str) -> int:
    y, m, d = (int(x) for x in birth_date.split("-"))
    today = date.today()
    return today.year - y - ((today.month, today.day) < (m, d))


def _player_name(p: dict) -> str:
    return f"{p['firstName']['default']} {p['lastName']['default']}"


# Prospects aren't scouting-ranked by the API (no draft position, no grade) —
# just capped per position group, youngest first, as a reasonable proxy for
# "still a prospect" rather than any claim about who's actually best.
_PROSPECT_CAPS = {"forwards": 5, "defensemen": 3, "goalies": 2}


def _top_prospects(prospects: dict) -> list[dict]:
    result = []
    for group, cap in _PROSPECT_CAPS.items():
        players = sorted(prospects.get(group, []), key=lambda p: p["birthDate"], reverse=True)
        for p in players[:cap]:
            result.append({
                "name": _player_name(p),
                "position": p["positionCode"],
                "age": _age(p["birthDate"]),
            })
    return result


async def fetch_team_stats(team: str) -> dict:
    abbrev = resolve_team(team)
    if not abbrev:
        return {"error": f"Unrecognized team: {team}"}

    async with httpx.AsyncClient(timeout=10, follow_redirects=True) as client:
        standings_res, stats_res, prospects_res = await asyncio.gather(
            client.get(f"{NHL_API}/standings/now"),
            client.get(f"{NHL_API}/club-stats/{abbrev}/now"),
            client.get(f"{NHL_API}/prospects/{abbrev}"),
        )

    if standings_res.status_code != 200 or stats_res.status_code != 200:
        return {"error": f"Could not fetch current stats for {abbrev}."}

    row = next(
        (
            s for s in standings_res.json().get("standings", [])
            if s["teamAbbrev"]["default"] == abbrev
        ),
        None,
    )
    record = None
    if row:
        record = {
            "wins": row["wins"], "losses": row["losses"], "ot_losses": row["otLosses"],
            "points": row["points"], "point_pctg": round(row["pointPctg"], 3),
            "streak": f"{row['streakCode']}{row['streakCount']}",
            "division_rank": row["divisionSequence"], "conference_rank": row["conferenceSequence"],
            "games_played": row["gamesPlayed"],
        }

    top_scorers = sorted(
        stats_res.json().get("skaters", []), key=lambda p: p.get("points", 0), reverse=True
    )[:5]
    top_scorers = [
        {
            "name": _player_name(p), "position": p["positionCode"],
            "goals": p["goals"], "assists": p["assists"], "points": p["points"],
            "games_played": p["gamesPlayed"],
        }
        for p in top_scorers
    ]

    prospects = _top_prospects(prospects_res.json()) if prospects_res.status_code == 200 else []

    return {
        "team": abbrev,
        "record": record,
        "top_scorers": top_scorers,
        "prospects": prospects,
        "note": (
            "Prospect list is unranked bio data (name/position/age only) — the NHL API has no "
            "scouting rank, so naming a 'best' prospect from this is an opinion, not a sourced "
            "fact. Same for any prediction about future results (e.g. championship odds): this "
            "data describes the team's current state, it does not forecast anything."
        ),
    }
