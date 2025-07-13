#!/usr/bin/env python3
"""
Analyze the negative image to identify unexposed film areas
and create a visualization showing where they are detected.
"""

import numpy as np
import cv2
from PIL import Image
import matplotlib.pyplot as plt

def analyze_negative_for_unexposed_areas(image_path):
    """
    Analyze a negative image to identify unexposed film areas
    """
    # Load the negative image
    img = cv2.imread(image_path)
    img_rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
    h, w = img_rgb.shape[:2]
    
    print(f"Image dimensions: {w}x{h}")
    print(f"Image shape: {img_rgb.shape}")
    
    # Convert to different color spaces for analysis
    img_hsv = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2HSV)
    img_lab = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2LAB)
    
    hue, sat, val = cv2.split(img_hsv)
    l_channel, a_channel, b_channel = cv2.split(img_lab)
    
    # Method 1: Look for very bright areas (unexposed film should be bright in negatives)
    brightness_threshold = np.percentile(val, 90)  # Top 10% brightest
    bright_mask = val > brightness_threshold
    
    # Method 2: Look for low saturation (unexposed film should be neutral)
    sat_threshold = np.percentile(sat, 30)  # Bottom 30% least saturated
    low_sat_mask = sat < sat_threshold
    
    # Method 3: Look for areas with consistent RGB values (film base should be uniform)
    # Calculate local standard deviation
    gray = cv2.cvtColor(img_rgb, cv2.COLOR_RGB2GRAY)
    kernel = np.ones((15, 15), np.float32) / 225
    local_mean = cv2.filter2D(gray.astype(np.float32), -1, kernel)
    local_sqr_mean = cv2.filter2D((gray.astype(np.float32))**2, -1, kernel)
    local_variance = local_sqr_mean - local_mean**2
    local_std = np.sqrt(np.maximum(local_variance, 0))
    
    consistency_threshold = np.percentile(local_std, 25)  # Bottom 25% most consistent
    consistent_mask = local_std < consistency_threshold
    
    # Method 4: Look for edge proximity (film borders are often at edges)
    edge_distance = np.zeros((h, w), dtype=np.float32)
    for i in range(h):
        for j in range(w):
            edge_distance[i, j] = min(i, j, h-1-i, w-1-j)
    
    edge_proximity_mask = edge_distance < min(h, w) * 0.05  # Within 5% of edge
    
    # Method 5: Look for specific color ranges that might indicate film base
    # In negatives, unexposed areas might have specific color characteristics
    r, g, b = cv2.split(img_rgb)
    
    # Look for areas where RGB values are similar (neutral)
    color_diff_rg = np.abs(r.astype(np.float32) - g.astype(np.float32))
    color_diff_rb = np.abs(r.astype(np.float32) - b.astype(np.float32))
    color_diff_gb = np.abs(g.astype(np.float32) - b.astype(np.float32))
    
    max_color_diff = np.maximum(np.maximum(color_diff_rg, color_diff_rb), color_diff_gb)
    neutral_threshold = np.percentile(max_color_diff, 25)  # Bottom 25% most neutral
    neutral_mask = max_color_diff < neutral_threshold
    
    # Combine methods with different weights
    # Unexposed film should be: bright AND (low_sat OR consistent OR neutral) AND possibly near edges
    unexposed_mask = bright_mask & (low_sat_mask | consistent_mask | neutral_mask)
    
    # Clean up the mask
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    unexposed_mask = cv2.morphologyEx(unexposed_mask.astype(np.uint8), cv2.MORPH_OPEN, kernel)
    unexposed_mask = cv2.morphologyEx(unexposed_mask, cv2.MORPH_CLOSE, kernel)
    
    # Count detected areas
    sample_count = np.sum(unexposed_mask > 0)
    total_pixels = h * w
    percentage = (sample_count / total_pixels) * 100
    
    print(f"\nDetection Results:")
    print(f"Bright areas: {np.sum(bright_mask)} pixels ({np.sum(bright_mask)/total_pixels*100:.1f}%)")
    print(f"Low saturation areas: {np.sum(low_sat_mask)} pixels ({np.sum(low_sat_mask)/total_pixels*100:.1f}%)")
    print(f"Consistent areas: {np.sum(consistent_mask)} pixels ({np.sum(consistent_mask)/total_pixels*100:.1f}%)")
    print(f"Neutral color areas: {np.sum(neutral_mask)} pixels ({np.sum(neutral_mask)/total_pixels*100:.1f}%)")
    print(f"Edge proximity areas: {np.sum(edge_proximity_mask)} pixels ({np.sum(edge_proximity_mask)/total_pixels*100:.1f}%)")
    print(f"Final unexposed film detection: {sample_count} pixels ({percentage:.1f}%)")
    
    # Sample colors from detected areas
    if sample_count > 0:
        sample_pixels = img_rgb[unexposed_mask > 0]
        avg_color = np.mean(sample_pixels, axis=0)
        median_color = np.median(sample_pixels, axis=0)
        
        print(f"\nDetected film base colors:")
        print(f"Average RGB: {avg_color}")
        print(f"Median RGB: {median_color}")
    
    # Create visualization
    fig, axes = plt.subplots(2, 3, figsize=(18, 12))
    
    # Original image
    axes[0, 0].imshow(img_rgb)
    axes[0, 0].set_title('Original Negative')
    axes[0, 0].axis('off')
    
    # Brightness analysis
    axes[0, 1].imshow(bright_mask, cmap='gray')
    axes[0, 1].set_title(f'Bright Areas (>{brightness_threshold:.0f})')
    axes[0, 1].axis('off')
    
    # Saturation analysis
    axes[0, 2].imshow(low_sat_mask, cmap='gray')
    axes[0, 2].set_title(f'Low Saturation (<{sat_threshold:.0f})')
    axes[0, 2].axis('off')
    
    # Consistency analysis
    axes[1, 0].imshow(consistent_mask, cmap='gray')
    axes[1, 0].set_title(f'Consistent Areas (<{consistency_threshold:.1f})')
    axes[1, 0].axis('off')
    
    # Neutral color analysis
    axes[1, 1].imshow(neutral_mask, cmap='gray')
    axes[1, 1].set_title(f'Neutral Colors (<{neutral_threshold:.1f})')
    axes[1, 1].axis('off')
    
    # Final detection
    axes[1, 2].imshow(img_rgb)
    # Overlay detection in green
    overlay = np.zeros((h, w, 4), dtype=np.uint8)
    overlay[..., 1] = 255  # Green
    overlay[..., 3] = unexposed_mask * 200  # Alpha
    
    # Blend overlay
    alpha = overlay[..., 3:4].astype(float) / 255
    img_with_overlay = (img_rgb * (1 - alpha) + overlay[..., :3] * alpha).astype(np.uint8)
    axes[1, 2].imshow(img_with_overlay)
    axes[1, 2].set_title(f'Detected Unexposed Film ({percentage:.1f}%)')
    axes[1, 2].axis('off')
    
    plt.tight_layout()
    plt.savefig('unexposed_film_analysis.png', dpi=150, bbox_inches='tight')
    plt.show()
    
    return unexposed_mask, sample_count, percentage

if __name__ == "__main__":
    image_path = "test_file.jpg"
    
    try:
        mask, count, percentage = analyze_negative_for_unexposed_areas(image_path)
        print(f"\nAnalysis complete! Visualization saved as 'unexposed_film_analysis.png'")
        print(f"Detected {count} pixels ({percentage:.1f}%) as unexposed film")
    except Exception as e:
        print(f"Error analyzing image: {e}")
