"""Pure helpers extensions import from ``publoader.utils.misc``.

The monolith's module also holds ``get_md_api`` and ``fetch_aggregate``, which
talk to MangaDex. Those are intentionally absent: upload authority never leaves
the core, and an extension that tried to call them would be reaching for a
credential a worker does not have.
"""

import asyncio
from typing import Dict, List, Optional
from urllib.parse import urlparse


def flatten(t: List[list]) -> list:
    """Flatten nested lists into one list."""
    return [item for sublist in t for item in sublist]


def find_key_from_list_value(
    dict_to_search: Dict[str, List[str]], list_element: str
) -> Optional[str]:
    """Get the key from the list value one."""
    for key in dict_to_search:
        if list_element in dict_to_search[key]:
            return key


def find_key_from_value(
    dict_to_search: Dict[str, str], element_value: str
) -> Optional[str]:
    """Get the key from the value in a dictionary."""
    for key, value in dict_to_search.items():
        if value == element_value:
            return key


def create_new_event_loop():
    """Return the event loop, create one if not there is not one running."""
    try:
        return asyncio.get_event_loop()
    except RuntimeError as e:
        if str(e).startswith("There is no current event loop in thread"):
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            return loop
        else:
            raise


def check_chapter_url_same(md_external_url: str, chapter_id: str) -> bool:
    """Check if the chapter id is present in the chapter"""
    if not md_external_url:
        return False
    try:
        parsed_url = urlparse(md_external_url)
        path = parsed_url.path.strip("/")
        path_segments = path.split("/")
        variable = chapter_id.strip("/")
        variable_segments = variable.split("/")
    except ValueError:
        return False

    path_match = any(segment in path_segments for segment in variable_segments)
    return path_match
