# Film Processing Algorithm Documentation

## Overview

This document provides comprehensive technical documentation for the film processing algorithm.

## Algorithm Summary

The film processing tool uses a sophisticated approach to convert film negatives to positive images with automatic color correction.

### Key Features

1. **Intelligent Film Base Detection**: Automatically detects unexposed film areas
2. **User-Controlled Correction**: Adjustable film correction strength (0-100%)
3. **Robust Fallback Methods**: Multiple detection strategies for reliability
4. **Professional Controls**: Exposure, contrast, gamma, color balance, etc.

### Technical Approach

#### 1. Edge Analysis
- Determines if image is full-frame or has borders
- Analyzes edge content variation and color consistency
- Guides film base detection strategy

#### 2. Film Base Detection
- **Thin Border Detection**: For full-frame shots (1-3 pixel borders)
- **Broad Border Detection**: For images with clear borders
- **Conservative Validation**: Ensures detected areas are actually unexposed film

#### 3. Color Correction
- Samples median color from detected unexposed areas
- Applies subtractive correction (industry standard)
- User-controllable strength prevents over-correction

#### 4. Fallback Strategies
- Corner sampling when main detection fails
- Conservative correction limits
- Always provides usable results

### Default Behavior

- **Film correction disabled by default** (strength = 0%)
- Provides bright, usable images without automatic over-darkening
- Users can enable and adjust correction as needed

### Performance Optimizations

- Cached processing stages
- Efficient image operations
- Memory-conscious design
- Large image exclusion from workspace

## Usage

See the main README.md for installation and usage instructions.

## Development Notes

This algorithm was developed through extensive testing and iteration to solve the "auto color correction makes images too dark" problem. The final solution prioritizes user control and reliable results over aggressive automatic correction.
