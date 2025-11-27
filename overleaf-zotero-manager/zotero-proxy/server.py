"""A simple Flask application to proxy Zotero API requests.
Modified version with support for personal user libraries.
"""

import asyncio
import logging
import os
from dataclasses import dataclass
from io import StringIO
from textwrap import indent
import secrets
import json
import aiohttp
from flask import Flask, Response, request
from werkzeug.datastructures import MultiDict

logger = logging.getLogger("zotero-proxy")
logger.setLevel(logging.INFO)
app = Flask(__name__)
app.secret_key = secrets.token_hex()


def _zotero_response_is_ok(response: aiohttp.ClientResponse) -> bool:
    """Handle the response from the Zotero API. Returns true if the response is OK.
    If the response is not OK, logs an error and returns false."""
    ok = True
    if response.status != 200:
        ok = False
        logger.error("Zotero API returned with code: %s", response.status)
        if response.status == 403:
            logger.error(
                "Check that the group/collection ID and key are correct and that the key has "
                "the necessary permissions."
            )
    return ok


async def _zotero_batched_request(
    url: str, headers: dict[str, str], default_parameters: dict[str, str], limit: int = 100
) -> list[str]:
    """Requests the url from the Zotero API. With parameter limit added to the default_parameters.
    If the response contains the header 'Total-Results' and it larger than limit, the function
    requests the next pages until all entries are fetched. Returns an array of all responses as
    text."""
    result = []
    parameters = {**default_parameters, "limit": limit}

    async with aiohttp.ClientSession() as session:
        # get first request
        async with session.get(
            url, headers=headers, params=parameters, timeout=30
        ) as initial_response:
            logger.info("Requested %s", initial_response.request_info.url)
            if not _zotero_response_is_ok(initial_response):
                return result
            total_entries = initial_response.headers["Total-Results"]
            text = await initial_response.text()
            result.append(text)

        # create a list of (start, limit) pairs for the next pages
        next_pages = []
        for start in range(limit, int(total_entries), limit):
            next_pages.append((start, limit))

        # get the next pages all at once
        tasks = []
        for start, limit in next_pages:
            tasks.append(
                session.get(
                    url,
                    headers=headers,
                    params={"start": start, **parameters},
                    timeout=30,
                )
            )
        # wait for all tasks to finish
        responses = await asyncio.gather(*tasks)
        for response in responses:
            logger.info("Requested %s", response.request_info.url)
            if not _zotero_response_is_ok(response):
                continue
            text = await response.text()
            result.append(text)

    return result


class Collections:
    """A class to store Zotero collection name mappings to their IDs."""

    def __init__(self):
        self.data: dict[str, dict[str, str]] = {}

    async def update_from_remote(self, group_id: str, key: str, is_user: bool = False):
        """Update the collection data from the Zotero API."""
        # Use 'users' or 'groups' depending on type
        entity_type = "users" if is_user else "groups"
        url = f"https://api.zotero.org/{entity_type}/{group_id}/collections"
        headers = {"Zotero-API-Key": key}
        collections = {}
        responses = await _zotero_batched_request(url, headers, {})
        raw_data = []
        for response in responses:
            raw_data += json.loads(response)

        def get_collection_data(collection_id: str):
            for collection in raw_data:
                if collection["key"] == collection_id:
                    return collection["data"]

        def get_collection_name(collection_id: str):
            for name, col_id in collections.items():
                if col_id == collection_id:
                    return name

        def add_collection(collection_id: str):
            if collection_id in collections:
                return
            data = get_collection_data(collection_id)
            if data is None:
                return
            if data["parentCollection"]:
                add_collection(data["parentCollection"])
                parent_name = get_collection_name(data["parentCollection"])
                collections[f"{parent_name}/{data['name']}"] = data["key"]
            else:
                collections[data["name"]] = data["key"]

        for collection in raw_data:
            add_collection(collection["key"])

        self.data[group_id] = collections

    async def get_collection_id(
        self,
        group_id: str,
        key: str,
        collection_name: str,
        is_user: bool = False,
    ) -> str:
        """Get the collection ID for a given collection name."""
        if group_id not in self.data or collection_name not in self.data[group_id]:
            await self.update_from_remote(group_id, key, is_user)
        return self.data[group_id][collection_name]

    async def get_collection_children(
        self, group_id: str, key: str, collection_id: str | None, is_user: bool = False
    ) -> list[tuple[str, str]]:
        """Get the children (collection IDs) of a collection.
        If the collection ID is None, return all collections in group."""
        # make sure data is fresh
        if group_id not in self.data or collection_id not in self.data[group_id].values():
            await self.update_from_remote(group_id, key, is_user)

        if group_id not in self.data:
            raise ValueError("Can't access group data")
        if collection_id is None:
            logger.info("No collection provided, assuming group root-level wanted")
            return list(self.data[group_id].items())
        elif collection_id not in self.data[group_id].values():
            raise ValueError("Collection not found")

        def get_collection_name(collection_id: str):
            for name, col_id in self.data[group_id].items():
                if col_id == collection_id:
                    return name

        collection_name = get_collection_name(collection_id)
        children = []
        for name, col_id in self.data[group_id].items():
            if name.startswith(collection_name + "/"):
                children.append((name, col_id))
        return children


COLLECTIONS = Collections()


@dataclass
class Config:
    group_id: str | None = None
    key: str | None = None
    result_format: str | None = None
    collection_id: str | None = None
    only_self: bool = False
    failed_collection_lookup: bool = False
    is_user: bool = False

    @classmethod
    def from_environment(cls):
        """Create a Config object populated with values from environment variables."""
        _inclusion_strategy = os.environ.get("ZOTERO_INCLUSION_STRATEGY", "")
        only_self = False
        if _inclusion_strategy == "only-self":
            only_self = True

        # Support both ZOTERO_GROUP and ZOTERO_USER
        group_id = os.environ.get("ZOTERO_GROUP")
        is_user = False
        if not group_id:
            group_id = os.environ.get("ZOTERO_USER")
            is_user = True

        return cls(
            group_id=group_id,
            key=os.environ.get("ZOTERO_KEY"),
            result_format=os.environ.get("ZOTERO_FORMAT", "bibtex"),
            collection_id=None,
            only_self=only_self,
            is_user=is_user,
        )

    async def update_from_request(self, path: str, query_parameters: MultiDict):
        """Add path and query parameters to the Config object."""
        self.group_id = query_parameters.get("group_id", self.group_id)
        self.key = query_parameters.get("key", self.key)
        self.result_format = query_parameters.get("format", self.result_format)
        _inclusion_strategy = query_parameters.get("inclusion_strategy")
        if _inclusion_strategy is not None:
            only_self = False
            if _inclusion_strategy == "only-self":
                only_self = True
            self.only_self = only_self

        if not self.is_valid():
            raise ValueError("Invalid configuration")

        # query parameters take precedence over environment variables and path
        if query_parameters.get("collection_id"):
            self.collection_id = query_parameters.get("collection_id")
        elif not path:
            logger.info("No collection ID found")
            self.collection_id = None
        else:  # try to get the collection ID from the path
            logger.info("Trying to get collection id from name %r", path)
            try:
                self.collection_id = await COLLECTIONS.get_collection_id(
                    group_id=self.group_id,
                    key=self.key,
                    collection_name=path,
                    is_user=self.is_user,
                )
            except KeyError:
                logger.error("Collection not found: %s", path)
                self.failed_collection_lookup = True

    def is_valid(self) -> bool:
        """Check if the Config object has all the required values."""
        error = False
        if not self.group_id:
            logger.error("`group_id` has not been set and is required")
            error = True
        if not self.key:
            logger.error("`key` has not been set and is required")
            error = True
        if error:
            logger.error(
                "Please set the environment variables `ZOTERO_GROUP` or `ZOTERO_USER` and `ZOTERO_KEY` "
                "or the `group_id` and `key` query parameters."
            )
        if self.result_format not in ["bibtex", "biblatex"]:
            logger.warning(
                "This has only been tested with bibtex and biblatex formats. "
                "Use at your own risk."
            )
        return not error


async def get_bibliography(
    group_id: str,
    key: str,
    result_format: str,
    collection_id: str | None = None,
    is_user: bool = False,
) -> str:
    """Get the bibliography from the Zotero API."""
    # Use 'users' or 'groups' depending on type
    entity_type = "users" if is_user else "groups"
    
    if collection_id is None:
        # Get all items from the library
        url = f"https://api.zotero.org/{entity_type}/{group_id}/items/top"
    else:
        # Get items from specific collection
        url = f"https://api.zotero.org/{entity_type}/{group_id}/collections/{collection_id}/items/top"

    headers = {"Zotero-API-Key": key}
    default_parameters = {
        "format": result_format,
        # exclude attachments, this reduces the number of requests to Zotero
        # by default these are included in the number of items but not returned
        # which leads to &start=100&limit=100 returning a block of ~50 items
        "itemType": "-attachment",
    }
    responses = await _zotero_batched_request(url, headers, default_parameters)
    responses = [response.strip() for response in responses]
    return "\n\n".join(responses)


def remove_duplicates(bibliography: str):
    """Remove duplicate entries from the bibliography."""
    # split the bibliography into entries
    entries = (bibliography).split("\n\n@")
    no_before = len(entries)
    all_keys = set()
    all_entries = set()
    result = []

    for entry in entries:
        entry = entry.strip()
        if not entry:
            continue
        if not entry.startswith("@"):
            entry = "@" + entry
        bib_key = entry.split("{")[1].split(",")[0]
        if entry in all_entries:
            logger.warning("Duplicate entry found, deduplicating: %s", bib_key)
            continue
        all_entries.add(entry)
        if bib_key in all_keys:
            logger.warning("Duplicate key found: %s", bib_key)
        all_keys.add(bib_key)
        result.append(entry)

    no_after = len(result)
    logger.info("Removed %s duplicates", no_before - no_after)
    logger.info("Returning %s entries", no_after)
    return "\n\n".join(result)


@app.route("/", defaults={"path": ""}, methods=["HEAD"])
@app.route("/<path:path>", methods=["HEAD"])
def head_handler(path):
    """Quick response for HEAD requests (used by Overleaf for URL validation)."""
    return Response("", mimetype="text/plain")

@app.route("/", defaults={"path": ""}, methods=["GET"])
@app.route("/<path:path>", methods=["GET"])
async def main(path):
    """The main entry point for the application."""
    # register a new logger for this request, so that we can add the logs as information
    # to the response
    logger_stream = StringIO()
    logger_stream_handler = logging.StreamHandler(logger_stream)
    logger_stream_handler.setLevel(logging.INFO)
    logger_stream_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)7s | %(message)s")
    )
    logger.addHandler(logger_stream_handler)
    bibliography = ""
    remove_comments = request.args.get("remove_comments") == "true"
    try:
        config = Config.from_environment()
        await config.update_from_request(path, request.args)
        logger.info("Using configuration:")
        logger.info("  Entity Type: %s", "User" if config.is_user else "Group")
        logger.info("  Entity ID: %s", config.group_id)
        logger.info("  Key: %s[omitted...]", config.key[:4] if config.key else "None")
        logger.info("  Format: %s", config.result_format)
        logger.info("  Collection ID: %s", config.collection_id)
        logger.info("  Inclusion Strategy: %s", "only-self" if config.only_self else "all")
        if config.failed_collection_lookup:
            raise ValueError(f"Failed to look up collection ID for path '{path}'")
        children = []
        if not config.only_self and config.collection_id:
            children = await COLLECTIONS.get_collection_children(
                group_id=config.group_id,
                key=config.key,
                collection_id=config.collection_id,
                is_user=config.is_user,
            )
            if children:
                logger.info("Including sub-collections:")
                for name, col_id in children:
                    logger.info("  %s: %s", name, col_id)
        tasks = [
            get_bibliography(
                group_id=config.group_id,
                key=config.key,
                result_format=config.result_format,
                collection_id=config.collection_id,
                is_user=config.is_user,
            )
        ]
        if children:
            tasks += [
                get_bibliography(
                    group_id=config.group_id,
                    key=config.key,
                    result_format=config.result_format,
                    collection_id=col_id,
                    is_user=config.is_user,
                )
                for _, col_id in children
            ]
        bibliographies = await asyncio.gather(*tasks)
        bibliography = "\n\n".join(bibliographies)
        bibliography = remove_duplicates(bibliography)
    except Exception:
        logger.exception("An error occurred")
    finally:
        logs = logger_stream.getvalue()
        logger.removeHandler(logger_stream_handler)
        logger_stream_handler.close()
        logger_stream.close()
    if remove_comments:
        result = bibliography
    else:
        result = indent(logs, prefix="% ") + "\n\n" + bibliography
    return Response(result, mimetype="text/plain")

if __name__ == "__main__":
    app.run(host="0.0.0.0")
