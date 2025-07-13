"""
Film Processing Package

A comprehensive tool for processing and correcting scanned film negatives.
"""

__version__ = "1.0.0"
__author__ = "Luke"

from .film_processing import FilmProcessor
from .image_processor import ImageProcessor

__all__ = ['FilmProcessor', 'ImageProcessor']
