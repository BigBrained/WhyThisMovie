Place local movie posters in this folder using the catalogue's zero-based index.

Examples:
  0.jpg
  1.jpg
  2.jpg

The poster downloader creates these names in exactly the order produced from the
alphabetically sorted CSV files in ../dataset/, after duplicate movie IDs are merged.
If a numbered JPG is missing or unreadable, the app generates an SVG fallback.
