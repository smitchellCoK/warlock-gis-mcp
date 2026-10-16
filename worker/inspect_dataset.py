"""Warlock GIS MCP - read-only dataset schema inspection worker (v0.1).

Run only by src/server.mjs with ArcGIS Pro's Python:

    python.exe inspect_dataset.py <DATASET>

Prints exactly one JSON object on stdout and exits 0. Everything else
(ArcPy messages, warnings, tracebacks) goes to stderr, which the server
discards.

Safety boundary:
- The connection file comes only from the fixed local config file
  (%LOCALAPPDATA%\\WarlockGisMcp\\config.json). The caller cannot supply a
  path, environment, SQL, or code.
- Only metadata calls are used: Exists, Describe, ListFields,
  ListDatasets, da.ListDomains, da.ListSubtypes. No cursors, no SQL, no
  geoprocessing tools, no writes.
- The connection file path, its folder and file name are never returned.
  Errors are returned as fixed codes only; raw ArcPy messages are never
  returned.

Requires ArcGIS Pro 3.3 (Python 3.11). Standard library and arcpy only.
"""

import datetime
import json
import os
import re
import sys

ENVIRONMENT = "PROD (read-only)"
CONFIG_DIR_NAME = "WarlockGisMcp"
CONFIG_FILE_NAME = "config.json"

# owner.name or database.owner.name - letters, digits, underscore only.
DATASET_NAME_RE = re.compile(r"^[A-Za-z0-9_]{1,128}(\.[A-Za-z0-9_]{1,128}){1,2}$")

SUPPORTED_DATASET_TYPES = ("FeatureClass", "Table")

# stdout is reserved for the single JSON result. Anything printed while
# working (including by arcpy) is sent to stderr instead.
_RESULT_STREAM = sys.stdout
sys.stdout = sys.stderr


class InspectionError(Exception):
    """Fail closed with a fixed error code."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")


def envelope(dataset, status, error_code):
    return {
        "status": status,
        "error_code": error_code,
        "environment": ENVIRONMENT,
        "dataset": dataset,
        "resolved_name": None,
        "dataset_type": None,
        "geometry_type": None,
        "versioned": None,
        "archived": None,
        "fields": None,
        "subtypes": None,
        "domains": None,
        "inspected_at": now_utc(),
    }


def emit(result):
    _RESULT_STREAM.write(json.dumps(result, ensure_ascii=True))
    _RESULT_STREAM.write("\n")
    _RESULT_STREAM.flush()


def jsonable(value):
    """Plain JSON value for defaults, coded values and range limits."""

    if value is None or isinstance(value, (bool, int, str)):
        return value
    if isinstance(value, float):
        return value if value == value and abs(value) != float("inf") else None
    if isinstance(value, (datetime.datetime, datetime.date, datetime.time)):
        return value.isoformat()
    return str(value)

#----------------------------------------------------------------------
# Configuration
#----------------------------------------------------------------------

def load_connection_file():
    """Fixed, local, read-only PROD connection file from the config file."""

    base = os.environ.get("LOCALAPPDATA", "")
    if not base:
        raise InspectionError("CONFIG_ERROR")

    config_path = os.path.join(base, CONFIG_DIR_NAME, CONFIG_FILE_NAME)

    try:
        with open(config_path, "r", encoding="utf-8") as handle:
            config = json.load(handle)
    except (OSError, ValueError):
        raise InspectionError("CONFIG_ERROR")

    sde = config.get("sdeConnectionFile") if isinstance(config, dict) else None

    if (
        not isinstance(sde, str)
        or not os.path.isabs(sde)
        or not sde.lower().endswith(".sde")
        or not os.path.isfile(sde)
    ):
        raise InspectionError("CONFIG_ERROR")

    return sde

#----------------------------------------------------------------------
# Inspection (metadata only)
#----------------------------------------------------------------------

def resolve(arcpy, sde, dataset):
    """Find the dataset at the workspace root or one level down in a
    feature dataset. Returns (catalog_path, relative_name) or None."""

    direct = os.path.join(sde, dataset)
    if arcpy.Exists(direct):
        return direct, None

    arcpy.env.workspace = sde
    for feature_dataset in arcpy.ListDatasets(feature_type="Feature") or []:
        candidate = os.path.join(sde, feature_dataset, dataset)
        if arcpy.Exists(candidate):
            return candidate, feature_dataset

    return None


def describe_fields(arcpy, path):
    fields = []
    for field in arcpy.ListFields(path):
        fields.append({
            "name": field.name,
            "alias": field.aliasName,
            "type": field.type,
            "length": field.length,
            "nullable": bool(field.isNullable),
            "required": bool(field.required),
            "default": jsonable(field.defaultValue),
            "domain": field.domain or None,
        })
    return fields


def describe_subtypes(arcpy, path, subtype_field):
    if not subtype_field:
        return None

    values = []
    default_code = None

    for code, info in sorted(arcpy.da.ListSubtypes(path).items()):
        field_domains = {}
        for field_name, pair in (info.get("FieldValues") or {}).items():
            domain = pair[1] if pair and len(pair) > 1 else None
            if domain is not None and getattr(domain, "name", None):
                field_domains[field_name] = domain.name

        if info.get("Default"):
            default_code = code

        values.append({
            "code": code,
            "name": info.get("Name"),
            "field_domains": field_domains,
        })

    return {
        "field": subtype_field,
        "default_code": default_code,
        "values": values,
    }


def describe_domains(arcpy, sde, names):
    """Definitions of the domains referenced by this dataset only."""

    wanted = {name.lower() for name in names}
    domains = []

    if not wanted:
        return domains

    for domain in arcpy.da.ListDomains(sde):
        if domain.name.lower() not in wanted:
            continue

        coded_values = None
        value_range = None

        if domain.domainType == "CodedValue":
            coded_values = [
                {"code": jsonable(code), "description": description}
                for code, description in (domain.codedValues or {}).items()
            ]
        elif domain.domainType == "Range" and domain.range:
            value_range = {
                "min": jsonable(domain.range[0]),
                "max": jsonable(domain.range[1]),
            }

        domains.append({
            "name": domain.name,
            "description": domain.description,
            "domain_type": domain.domainType,
            "field_type": domain.type,
            "coded_values": coded_values,
            "range": value_range,
        })

    return sorted(domains, key=lambda item: item["name"].lower())


def inspect(dataset):
    sde = load_connection_file()

    try:
        import arcpy
    except Exception:
        raise InspectionError("ARCPY_UNAVAILABLE")

    try:
        found = resolve(arcpy, sde, dataset)
        if found is None:
            return envelope(dataset, "not_found", "NOT_FOUND"), sde

        path, feature_dataset = found
        desc = arcpy.Describe(path)

        dataset_type = getattr(desc, "dataType", None)
        if dataset_type not in SUPPORTED_DATASET_TYPES:
            raise InspectionError("UNSUPPORTED_DATASET_TYPE")

        name = desc.name
        resolved = f"{feature_dataset}/{name}" if feature_dataset else name

        fields = describe_fields(arcpy, path)
        subtype_field = getattr(desc, "subtypeFieldName", "") or None
        subtypes = describe_subtypes(arcpy, path, subtype_field)

        referenced = {f["domain"] for f in fields if f["domain"]}
        if subtypes:
            for value in subtypes["values"]:
                referenced.update(value["field_domains"].values())

        result = envelope(dataset, "ok", None)
        result.update({
            "resolved_name": resolved,
            "dataset_type": dataset_type,
            "geometry_type": (
                getattr(desc, "shapeType", None)
                if dataset_type == "FeatureClass" else None
            ),
            "versioned": getattr(desc, "isVersioned", None),
            "archived": getattr(desc, "isArchived", None),
            "fields": fields,
            "subtypes": subtypes,
            "domains": describe_domains(arcpy, sde, referenced),
        })
        return result, sde

    except InspectionError:
        raise
    except Exception:
        raise InspectionError("INSPECTION_FAILED")


def leaks_connection_details(result, sde):
    """True if the connection file path, folder or name appears anywhere
    in the result."""

    text = json.dumps(result, ensure_ascii=True).lower()
    needles = {
        os.path.normcase(sde).lower(),
        os.path.dirname(sde).lower(),
        os.path.basename(sde).lower(),
    }
    escaped = {json.dumps(n)[1:-1] for n in needles if n}
    return any(n and n in text for n in needles | escaped)

#----------------------------------------------------------------------
# Entry point
#----------------------------------------------------------------------

def main(argv):
    dataset = argv[1] if len(argv) == 2 else ""

    if not DATASET_NAME_RE.match(dataset):
        emit(envelope(None, "error", "INVALID_NAME"))
        return 0

    try:
        result, sde = inspect(dataset)
        if leaks_connection_details(result, sde):
            result = envelope(dataset, "error", "OUTPUT_REJECTED")
    except InspectionError as error:
        result = envelope(dataset, "error", error.code)
    except Exception:
        result = envelope(dataset, "error", "INSPECTION_FAILED")

    emit(result)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
