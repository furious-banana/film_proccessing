import logging
from PIL import Image
import numpy as np
import cv2

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger('FilmProcessor')

class FilmProcessor:
    def __init__(self, image_array):
        self.original = image_array
        self.params = {
            'contrast': 1.0,
            'saturation': 1.0,
            'red_balance': 1.0,
            'green_balance': 1.0,
            'blue_balance': 1.0,
            'gamma': 1.0,
            'exposure': 0.0,  # Start with neutral exposure - let user adjust as needed
            'highlight_recovery': 0.0,
            'shadow_recovery': 0.0,
            'temperature': 0.0,
            'tint': 0.0,
            'clarity': 0.0,
            'dehaze': 0.0,
            'film_correction': 0.0,  # Film base subtraction: 0 = no correction, 1 = full correction
            'auto_levels': 1.0,      # Auto levels: 0 = disabled, 1 = enabled
            'auto_white_balance': 1.0  # Auto white balance: 0 = disabled, 1 = enabled
        }
        self.cached_stages = {}
        self.debug_dims = None
        self.debug_mask = None
        self.film_mask = None
        self._initialize_cache()

    def _initialize_cache(self):
        """Initialize the processing cache with the initial image inversion and analysis"""
        try:
            # Ensure original image is 3-channel RGB
            logger.info(f"Input image shape: {self.original.shape}")
            if len(self.original.shape) == 2:
                logger.info("Converting grayscale to RGB")
                self.original = np.stack([self.original] * 3, axis=-1)
            elif len(self.original.shape) == 3 and self.original.shape[2] != 3:
                logger.warning(f"Input image has {self.original.shape[2]} channels, converting to RGB")
                self.original = np.array(Image.fromarray(self.original).convert('RGB'))
            elif len(self.original.shape) != 3:
                logger.error(f"Unexpected image shape: {self.original.shape}")
                raise ValueError(f"Cannot process image with shape {self.original.shape}")

            logger.info(f"Original image shape after conversion: {self.original.shape}")
            
            # Basic inversion first - invert each channel separately
            inverted = (255 - self.original).astype(np.uint8)
            logger.info(f"Inverted image shape: {inverted.shape}")
            self.cached_stages['inverted'] = inverted
            
            # Convert to float32 for processing
            img_float = inverted.astype(np.float32) / 255.0
            logger.info(f"Float image shape: {img_float.shape}")
            
            try:
                # Analyze the original negative to find unexposed film areas
                neg_analysis = self._analyze_negative_characteristics(self.original)
                
                if neg_analysis and isinstance(neg_analysis, dict):
                    # Get film base color but apply correction based on parameter
                    film_base_color = neg_analysis.get('film_base_color', np.zeros(3))
                    correction_strength = self.params.get('film_correction', 0.0)
                    
                    logger.info(f"Film base color detected: R={film_base_color[0]:.3f}, G={film_base_color[1]:.3f}, B={film_base_color[2]:.3f}")
                    logger.info(f"Film correction strength: {correction_strength:.2f}")
                    
                    if correction_strength > 0.01:  # Only apply if user wants correction
                        # Apply film base subtraction - subtract the film base color directly
                        # film_base_color is already in 0-255 range, convert to 0-1 range
                        film_base_normalized = film_base_color / 255.0
                        
                        # Apply correction with user-controlled strength
                        correction = film_base_normalized * correction_strength
                        img_float = img_float - correction
                        
                        # Ensure we don't go below zero or above 1
                        img_float = np.clip(img_float, 0.0, 1.0)
                        
                        logger.info(f"Applied film base subtraction: R={correction[0]:.3f}, G={correction[1]:.3f}, B={correction[2]:.3f}")
                        logger.info(f"Correction strength: {correction_strength:.2f}")
                        
                    else:
                        logger.info("Film base correction disabled (strength = 0)")
                
                # Step 2: Auto color correct to highlights (if enabled) - apply regardless of film correction
                if self.params.get('auto_levels', 1.0) > 0.5:
                    img_float, color_adjustments = self._auto_color_correct_to_highlights(img_float)
                else:
                    logger.info("Auto levels disabled")
                
                # Step 3: Auto white balance (if enabled) - apply regardless of film correction  
                if self.params.get('auto_white_balance', 1.0) > 0.5:
                    img_float, wb_adjustments = self._auto_white_balance_combination(img_float)
                else:
                    logger.info("Auto white balance disabled")
                        
            except Exception as e:
                logger.warning(f"Film analysis failed, using basic inversion only: {str(e)}")
                # Analysis failed, but we can continue with basic inversion
                
            # Store final processed version
            self.cached_stages['initial'] = np.clip(img_float * 255, 0, 255).astype(np.uint8)
            
        except Exception as e:
            logger.error(f"Cache initialization failed: {str(e)}")
            # Absolute fallback - ensure we have a valid 3-channel image
            if len(self.original.shape) == 2:
                inverted = np.stack([(255 - self.original)] * 3, axis=-1)
            else:
                inverted = (255 - self.original).astype(np.uint8)
            self.cached_stages['initial'] = inverted

    def _analyze_negative_characteristics(self, original_negative):
        """
        Correct film base detection approach:
        1. Find brightest pixels in the original negative (unexposed film)
        2. Invert those pixels to see what color they become after inversion
        3. That inverted color is what gets subtracted from the entire inverted image
        """
        logger.info("Starting film base detection on negative")
        
        try:
            h, w = original_negative.shape[:2]
            
            # Step 1: Find the single brightest pixel in the negative (unexposed film)
            # Convert to grayscale to find overall brightness
            if len(original_negative.shape) == 3:
                gray = cv2.cvtColor(original_negative, cv2.COLOR_RGB2GRAY)
            else:
                gray = original_negative
            
            # Find the single brightest pixel
            max_location = np.unravel_index(np.argmax(gray), gray.shape)
            logger.info(f"Brightest pixel found at location: {max_location}")
            
            # Sample the color of this single brightest pixel
            negative_unexposed_color = original_negative[max_location]
            logger.info(f"Single brightest pixel color in negative: R={negative_unexposed_color[0]}, G={negative_unexposed_color[1]}, B={negative_unexposed_color[2]}")
            
            # Step 3: Invert this color to see what it becomes after inversion
            # This inverted color is what we subtract from the entire inverted image
            inverted_unexposed_color = 255 - negative_unexposed_color
            logger.info(f"Inverted unexposed color (to subtract): R={inverted_unexposed_color[0]:.1f}, G={inverted_unexposed_color[1]:.1f}, B={inverted_unexposed_color[2]:.1f}")
            
            # Store debug information - create a single pixel mask
            debug_mask = np.zeros_like(gray, dtype=np.uint8)
            debug_mask[max_location] = 255
            self.debug_mask = debug_mask
            self.debug_dims = (h, w)
            
            return {
                'film_base_color': inverted_unexposed_color,  # This is the color to subtract
                'color_matrix': np.eye(3),  # No color matrix - just subtraction
                'fine_tuning': np.eye(3)
            }
            
        except Exception as e:
            logger.error(f"Error in film base detection: {str(e)}")
            return self._get_minimal_correction()

    def _get_minimal_correction(self):
        """Return minimal correction when detection fails"""
        return {
            'film_base_color': np.array([128, 128, 128]),  # Neutral gray - minimal correction
            'color_matrix': np.eye(3),
            'fine_tuning': np.eye(3)
        }

    def _ensure_3d_shape(self, img, operation_name="unknown"):
        """Ensure image has proper 3D shape (H, W, 3)"""
        if len(img.shape) == 2:
            logger.debug(f"Converting 2D to 3D after {operation_name}")
            return np.stack([img] * 3, axis=-1)
        elif len(img.shape) == 3 and img.shape[2] != 3:
            logger.debug(f"Converting {img.shape[2]}-channel to 3-channel after {operation_name}")
            return np.array(Image.fromarray((img * 255).astype(np.uint8)).convert('RGB')).astype(np.float32) / 255.0
        elif len(img.shape) != 3:
            logger.error(f"Invalid shape {img.shape} after {operation_name}")
            raise ValueError(f"Cannot process image with shape {img.shape}")
        return img

    def get_processed_image(self):
        """Apply all current parameters to the image and return the result"""
        try:
            # Check if we have the initial processed version with current parameters
            initial = self.cached_stages.get('initial')
            
            if initial is None:
                # Need to regenerate initial processing with current film correction
                logger.info("Regenerating initial processing with current parameters")
                initial = self._regenerate_initial_processing()
                
            logger.info(f"Initial shape from cache: {initial.shape}")
            processed = initial.astype(np.float32) / 255.0
            logger.info(f"Processed shape after float conversion: {processed.shape}")
            
            # Ensure we have a 3-channel image at the start
            if len(processed.shape) == 2:
                logger.info(f"Converting single-channel image {processed.shape} to 3-channel")
                processed = np.stack([processed] * 3, axis=-1)
                logger.info(f"Shape after channel conversion: {processed.shape}")
            elif len(processed.shape) == 3 and processed.shape[2] != 3:
                logger.warning(f"Image has {processed.shape[2]} channels, converting to RGB")
                processed = np.array(Image.fromarray((processed * 255).astype(np.uint8)).convert('RGB')).astype(np.float32) / 255.0
                logger.info(f"Shape after RGB conversion: {processed.shape}")
            elif len(processed.shape) != 3:
                logger.error(f"Unexpected image shape: {processed.shape}")
                raise ValueError(f"Cannot process image with shape {processed.shape}")

            # Apply exposure adjustment
            if self.params['exposure'] != 0:
                processed *= 2 ** self.params['exposure']
                processed = self._ensure_3d_shape(processed, "exposure")
                logger.debug(f"Processed shape after exposure: {processed.shape}")

            # Apply contrast
            if self.params['contrast'] != 1.0:
                processed = np.power(processed, self.params['contrast'])
                processed = self._ensure_3d_shape(processed, "contrast")
                logger.debug(f"Processed shape after contrast: {processed.shape}")

            # Apply color balance
            if any(self.params[key] != 1.0 for key in ['red_balance', 'green_balance', 'blue_balance']):
                color_matrix = np.array([
                    [self.params['red_balance'], 0, 0],
                    [0, self.params['green_balance'], 0],
                    [0, 0, self.params['blue_balance']]
                ])
                # Validate shape before matrix multiplication
                if len(processed.shape) != 3 or processed.shape[2] != 3:
                    logger.error(f"Invalid shape for color matrix: {processed.shape}")
                    raise ValueError(f"Expected (H, W, 3) shape, got {processed.shape}")
                processed = np.dot(processed.reshape(-1, 3), color_matrix.T).reshape(processed.shape)
                processed = self._ensure_3d_shape(processed, "color_balance")
                logger.debug(f"Processed shape after color balance: {processed.shape}")

            # Apply gamma correction
            if self.params['gamma'] != 1.0:
                processed = np.power(processed, 1.0 / self.params['gamma'])
                processed = self._ensure_3d_shape(processed, "gamma")
                logger.debug(f"Processed shape after gamma: {processed.shape}")

            # Apply saturation
            if self.params['saturation'] != 1.0:
                # Convert to HSV for saturation adjustment
                hsv = cv2.cvtColor((processed * 255).astype(np.uint8), cv2.COLOR_RGB2HSV).astype(np.float32)
                hsv[..., 1] *= self.params['saturation']
                processed = cv2.cvtColor(np.clip(hsv, 0, 255).astype(np.uint8), cv2.COLOR_HSV2RGB).astype(np.float32) / 255.0
                processed = self._ensure_3d_shape(processed, "saturation")
                logger.debug(f"Processed shape after saturation: {processed.shape}")

            # Apply highlight and shadow recovery
            if self.params['highlight_recovery'] > 0 or self.params['shadow_recovery'] > 0:
                try:
                    # Ensure we're working with a 3-channel image
                    if len(processed.shape) != 3 or processed.shape[2] != 3:
                        logger.warning(f"Expected 3-channel image, got shape {processed.shape}. Converting...")
                        if len(processed.shape) == 2:
                            processed = np.stack([processed] * 3, axis=-1)
                        elif processed.shape[2] != 3:
                            processed = np.array(Image.fromarray((processed * 255).astype(np.uint8)).convert('RGB')).astype(np.float32) / 255.0

                    logger.debug(f"Processed shape before highlight/shadow: {processed.shape}")
                    
                    # Calculate luminance - ensure processed is 3D
                    if len(processed.shape) == 3:
                        luminance = np.mean(processed, axis=2)
                    else:
                        logger.error(f"Unexpected processed shape for luminance calculation: {processed.shape}")
                        raise ValueError(f"Cannot calculate luminance for shape {processed.shape}")
                    
                    logger.debug(f"Luminance shape: {luminance.shape}")
                    highlights = np.clip((luminance - 0.5) * 2, 0, 1)
                    shadows = np.clip((0.5 - luminance) * 2, 0, 1)
                    
                    highlight_mask = 1 - (highlights * self.params['highlight_recovery'])
                    shadow_mask = 1 + (shadows * self.params['shadow_recovery'])
                    
                    # Create a combined mask and properly broadcast it to all color channels
                    combined_mask = highlight_mask * shadow_mask
                    logger.debug(f"Combined mask shape: {combined_mask.shape}")
                    
                    # Ensure proper broadcasting by expanding mask dimensions
                    if len(combined_mask.shape) == 2:
                        combined_mask = np.expand_dims(combined_mask, axis=2)
                    
                    logger.debug(f"Final mask shape: {combined_mask.shape}, processed shape: {processed.shape}")
                    
                    # Apply the mask - make sure shapes are compatible
                    if combined_mask.shape[:2] != processed.shape[:2]:
                        logger.error(f"Shape mismatch: mask {combined_mask.shape} vs processed {processed.shape}")
                        raise ValueError(f"Mask and image shape mismatch")
                    
                    processed = processed * combined_mask  # Broadcasting should work now
                    
                    logger.debug(f"Processed shape after highlight/shadow: {processed.shape}")
                except Exception as e:
                    logger.error(f"Error in highlight/shadow recovery: {str(e)}, shapes: processed={processed.shape}, mask={combined_mask.shape if 'combined_mask' in locals() else 'not created'}")
                    # Continue processing without highlight/shadow recovery

            # Final cleanup and validation
            processed = np.clip(processed * 255, 0, 255).astype(np.uint8)
            
            # Final shape validation
            if len(processed.shape) != 3 or processed.shape[2] != 3:
                logger.warning(f"Final processed image has unexpected shape {processed.shape}, fixing...")
                if len(processed.shape) == 2:
                    processed = np.stack([processed] * 3, axis=-1)
                else:
                    processed = np.array(Image.fromarray(processed).convert('RGB'))
                logger.info(f"Final corrected shape: {processed.shape}")
            
            return processed

        except Exception as e:
            logger.error(f"Error processing image: {str(e)}")
            # Return the basic inverted image as fallback, ensuring it's 3-channel
            fallback = self.cached_stages.get('initial', self.cached_stages.get('inverted'))
            if len(fallback.shape) == 2:
                fallback = np.stack([fallback] * 3, axis=-1)
            elif len(fallback.shape) == 3 and fallback.shape[2] != 3:
                fallback = np.array(Image.fromarray(fallback).convert('RGB'))
            return fallback

    def update_params(self, **kwargs):
        """Update processing parameters and apply them to the image"""
        # Update parameters with new values
        for key, value in kwargs.items():
            if key in self.params:
                self.params[key] = value
        
        # Clear the processed results to force reprocessing with new parameters
        # Keep 'inverted' but clear 'initial' since it contains the film correction
        keys_to_clear = [k for k in self.cached_stages.keys() if k not in ['inverted']]
        for key in keys_to_clear:
            del self.cached_stages[key]
            
        logger.info(f"Updated params: {kwargs}")
        logger.info(f"film_correction now: {self.params['film_correction']}")

    def _regenerate_initial_processing(self):
        """Regenerate the initial processing stage with current film correction parameters"""
        # Start with the basic inverted image
        inverted = self.cached_stages.get('inverted')
        if inverted is None:
            raise ValueError("No inverted image available in cache")
            
        # Convert to float for processing
        img_float = inverted.astype(np.float32) / 255.0
        
        try:
            # Apply film correction if enabled
            correction_strength = self.params.get('film_correction', 0.0)
            
            if correction_strength > 0.01:
                # Analyze the original negative to find film base color
                neg_analysis = self._analyze_negative_characteristics(self.original)
                
                if neg_analysis and isinstance(neg_analysis, dict):
                    film_base_color = neg_analysis.get('film_base_color', np.zeros(3))
                    
                    logger.info(f"Regenerating with film correction: R={film_base_color[0]:.1f}, G={film_base_color[1]:.1f}, B={film_base_color[2]:.1f}")
                    logger.info(f"Film correction strength: {correction_strength:.2f}")
                    
                    # Apply film base subtraction - subtract the film base color directly
                    film_base_normalized = film_base_color / 255.0
                    correction = film_base_normalized * correction_strength
                    img_float = img_float - correction
                    
                    # Ensure we don't go below zero or above 1
                    img_float = np.clip(img_float, 0.0, 1.0)
                    
                    logger.info(f"Applied film base subtraction: R={correction[0]:.3f}, G={correction[1]:.3f}, B={correction[2]:.3f}")
                    
                else:
                    logger.warning("Could not get film base color for regeneration")
            else:
                logger.info("Film correction disabled for regeneration")
                
            # Step 2: Auto color correct to highlights (if enabled) - apply regardless of film correction
            if self.params.get('auto_levels', 1.0) > 0.5:
                img_float, color_adjustments = self._auto_color_correct_to_highlights(img_float)
            else:
                logger.info("Auto levels disabled")
            
            # Step 3: Auto white balance (if enabled) - apply regardless of film correction
            if self.params.get('auto_white_balance', 1.0) > 0.5:
                img_float, wb_adjustments = self._auto_white_balance_combination(img_float)
            else:
                logger.info("Auto white balance disabled")
                
        except Exception as e:
            logger.error(f"Error in film correction during regeneration: {str(e)}")
            
        # Convert back to uint8 and cache
        result = np.clip(img_float * 255, 0, 255).astype(np.uint8)
        self.cached_stages['initial'] = result
        
        return result

    def _auto_color_correct_to_highlights(self, img_float):
        """
        Automatically adjust RGB channels so highlights just peak by a small number of pixels
        """
        logger.info("Starting automatic color correction to highlights")
        
        try:
            # Define what "just peaking" means - allow this many pixels to clip per channel
            max_clipped_pixels = max(10, int(img_float.shape[0] * img_float.shape[1] * 0.0001))  # 0.01% of pixels
            logger.info(f"Target: max {max_clipped_pixels} clipped pixels per channel")
            
            # Work on each channel separately
            corrected = img_float.copy()
            adjustments = []
            
            for channel in range(3):
                channel_name = ['Red', 'Green', 'Blue'][channel]
                channel_data = img_float[:, :, channel]
                
                # Find the current maximum value
                current_max = np.max(channel_data)
                logger.info(f"{channel_name} channel current max: {current_max:.3f}")
                
                # Binary search to find the right multiplier
                # We want to scale the channel so that only max_clipped_pixels exceed 1.0
                min_multiplier = 0.1
                max_multiplier = 10.0
                best_multiplier = 1.0
                
                for iteration in range(20):  # Binary search iterations
                    test_multiplier = (min_multiplier + max_multiplier) / 2
                    test_channel = channel_data * test_multiplier
                    clipped_pixels = np.sum(test_channel > 1.0)
                    
                    if clipped_pixels <= max_clipped_pixels:
                        # Too few clipped pixels, can increase multiplier
                        min_multiplier = test_multiplier
                        best_multiplier = test_multiplier
                    else:
                        # Too many clipped pixels, need to decrease multiplier
                        max_multiplier = test_multiplier
                    
                    # If we're close enough, stop
                    if abs(clipped_pixels - max_clipped_pixels) <= 5:
                        best_multiplier = test_multiplier
                        break
                
                # Apply the best multiplier to this channel
                corrected[:, :, channel] = channel_data * best_multiplier
                adjustments.append(best_multiplier)
                
                # Final check
                final_clipped = np.sum(corrected[:, :, channel] > 1.0)
                logger.info(f"{channel_name} channel: multiplier={best_multiplier:.3f}, clipped_pixels={final_clipped}")
            
            # Clip to valid range
            corrected = np.clip(corrected, 0.0, 1.0)
            
            logger.info(f"Color correction complete: R×{adjustments[0]:.3f}, G×{adjustments[1]:.3f}, B×{adjustments[2]:.3f}")
            
            # Log the actual effect
            original_range = f"R:{img_float[:,:,0].min():.3f}-{img_float[:,:,0].max():.3f}, G:{img_float[:,:,1].min():.3f}-{img_float[:,:,1].max():.3f}, B:{img_float[:,:,2].min():.3f}-{img_float[:,:,2].max():.3f}"
            corrected_range = f"R:{corrected[:,:,0].min():.3f}-{corrected[:,:,0].max():.3f}, G:{corrected[:,:,1].min():.3f}-{corrected[:,:,1].max():.3f}, B:{corrected[:,:,2].min():.3f}-{corrected[:,:,2].max():.3f}"
            logger.info(f"Auto levels effect - Before: {original_range}")
            logger.info(f"Auto levels effect - After: {corrected_range}")
            
            return corrected, adjustments
            
        except Exception as e:
            logger.error(f"Error in auto color correction: {str(e)}")
            return img_float, [1.0, 1.0, 1.0]

    def _auto_white_balance_combination(self, img_float):
        """
        Combination white balance approach:
        1. Use highlights for initial white balance 
        2. Fine-tune with overall image statistics
        3. Apply film-specific knowledge
        """
        logger.info("Starting combination white balance correction")
        
        try:
            # Step 1: Highlight-based white balance
            gray = np.mean(img_float, axis=2)
            
            # Find brightest 2% of pixels (likely white/neutral areas)
            highlight_threshold = np.percentile(gray, 98)
            highlight_mask = gray >= highlight_threshold
            
            num_highlight_pixels = np.sum(highlight_mask)
            logger.info(f"Found {num_highlight_pixels} highlight pixels for white balance")
            
            if num_highlight_pixels > 10:  # Need enough pixels for reliable sampling
                # Average the highlight pixels - these should be neutral
                highlight_r = np.mean(img_float[highlight_mask, 0])
                highlight_g = np.mean(img_float[highlight_mask, 1]) 
                highlight_b = np.mean(img_float[highlight_mask, 2])
                
                logger.info(f"Highlight colors: R={highlight_r:.3f}, G={highlight_g:.3f}, B={highlight_b:.3f}")
                
                # Calculate initial white balance factors
                # Use green as reference (it's usually most accurate)
                highlight_wb_r = highlight_g / highlight_r if highlight_r > 0.01 else 1.0
                highlight_wb_g = 1.0  # Green is reference
                highlight_wb_b = highlight_g / highlight_b if highlight_b > 0.01 else 1.0
                
                logger.info(f"Highlight-based WB factors: R={highlight_wb_r:.3f}, G={highlight_wb_g:.3f}, B={highlight_wb_b:.3f}")
                
            else:
                logger.warning("Insufficient highlight pixels, using neutral factors")
                highlight_wb_r = highlight_wb_g = highlight_wb_b = 1.0
            
            # Step 2: Fine-tune with overall image statistics
            # Calculate average color of mid-tones (avoid pure blacks and blown highlights)
            midtone_mask = (gray > 0.1) & (gray < 0.8)
            
            if np.sum(midtone_mask) > 100:
                midtone_r = np.mean(img_float[midtone_mask, 0])
                midtone_g = np.mean(img_float[midtone_mask, 1])
                midtone_b = np.mean(img_float[midtone_mask, 2])
                
                # Calculate how far midtones are from neutral
                midtone_target = (midtone_r + midtone_g + midtone_b) / 3
                midtone_wb_r = midtone_target / midtone_r if midtone_r > 0.01 else 1.0
                midtone_wb_g = midtone_target / midtone_g if midtone_g > 0.01 else 1.0
                midtone_wb_b = midtone_target / midtone_b if midtone_b > 0.01 else 1.0
                
                logger.info(f"Midtone-based WB factors: R={midtone_wb_r:.3f}, G={midtone_wb_g:.3f}, B={midtone_wb_b:.3f}")
                
                # Blend highlight and midtone corrections (favor highlights but consider midtones)
                blend_weight = 0.7  # 70% highlights, 30% midtones
                final_wb_r = highlight_wb_r * blend_weight + midtone_wb_r * (1 - blend_weight)
                final_wb_g = highlight_wb_g * blend_weight + midtone_wb_g * (1 - blend_weight)
                final_wb_b = highlight_wb_b * blend_weight + midtone_wb_b * (1 - blend_weight)
                
            else:
                logger.warning("Insufficient midtone pixels, using highlight-only correction")
                final_wb_r = highlight_wb_r
                final_wb_g = highlight_wb_g
                final_wb_b = highlight_wb_b
            
            # Step 3: Apply film-specific knowledge
            # Film typically has slight color casts that should be corrected
            # After film base removal, we often need to reduce blue/cyan cast
            film_correction_r = 1.0      # Red usually needs minimal adjustment
            film_correction_g = 0.98     # Green slight reduction
            film_correction_b = 0.92     # Blue typically needs most reduction
            
            # Combine white balance with film-specific corrections
            combined_r = final_wb_r * film_correction_r
            combined_g = final_wb_g * film_correction_g  
            combined_b = final_wb_b * film_correction_b
            
            # Normalize to prevent over-brightening (keep the brightest factor at or below 1.1)
            max_factor = max(combined_r, combined_g, combined_b)
            if max_factor > 1.1:
                normalization = 1.1 / max_factor
                combined_r *= normalization
                combined_g *= normalization
                combined_b *= normalization
            
            logger.info(f"Final WB factors: R={combined_r:.3f}, G={combined_g:.3f}, B={combined_b:.3f}")
            
            # Apply the white balance correction
            corrected = img_float.copy()
            corrected[:, :, 0] *= combined_r
            corrected[:, :, 1] *= combined_g
            corrected[:, :, 2] *= combined_b
            
            # Clip to valid range
            corrected = np.clip(corrected, 0.0, 1.0)
            
            # Log the actual effect
            original_range = f"R:{img_float[:,:,0].min():.3f}-{img_float[:,:,0].max():.3f}, G:{img_float[:,:,1].min():.3f}-{img_float[:,:,1].max():.3f}, B:{img_float[:,:,2].min():.3f}-{img_float[:,:,2].max():.3f}"
            corrected_range = f"R:{corrected[:,:,0].min():.3f}-{corrected[:,:,0].max():.3f}, G:{corrected[:,:,1].min():.3f}-{corrected[:,:,1].max():.3f}, B:{corrected[:,:,2].min():.3f}-{corrected[:,:,2].max():.3f}"
            logger.info(f"Auto white balance effect - Before: {original_range}")
            logger.info(f"Auto white balance effect - After: {corrected_range}")
            logger.info("White balance correction complete")
            
            return corrected, [combined_r, combined_g, combined_b]
            
        except Exception as e:
            logger.error(f"Error in white balance correction: {str(e)}")
            return img_float, [1.0, 1.0, 1.0]