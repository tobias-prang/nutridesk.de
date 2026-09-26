CREATE TABLE IF NOT EXISTS foods (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  barcode VARCHAR(32) NULL,
  source_id VARCHAR(64) NULL,
  name VARCHAR(200) NOT NULL,
  brand VARCHAR(140) NULL,
  kcal DECIMAL(8,2) NOT NULL DEFAULT 0,
  carbs DECIMAL(8,2) NOT NULL DEFAULT 0,
  protein DECIMAL(8,2) NOT NULL DEFAULT 0,
  fat DECIMAL(8,2) NOT NULL DEFAULT 0,
  source VARCHAR(40) NOT NULL DEFAULT 'manual',
  market_de TINYINT(1) NOT NULL DEFAULT 0,
  image_small_url VARCHAR(500) NULL,
  normalized_name VARCHAR(200) GENERATED ALWAYS AS (LOWER(TRIM(name))) STORED,
  UNIQUE KEY uq_food_barcode (barcode),
  UNIQUE KEY uq_food_source_id (source, source_id),
  KEY idx_food_normalized_name (normalized_name),
  FULLTEXT KEY ft_food_name_brand (name, brand)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recipes (
  id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(160) NOT NULL,
  meal ENUM('fruh','mittag','abend','snack') NOT NULL,
  servings TINYINT UNSIGNED NOT NULL DEFAULT 1,
  time_min SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  kcal DECIMAL(8,2) NOT NULL DEFAULT 0,
  carbs DECIMAL(8,2) NOT NULL DEFAULT 0,
  protein DECIMAL(8,2) NOT NULL DEFAULT 0,
  fat DECIMAL(8,2) NOT NULL DEFAULT 0,
  tags VARCHAR(255) NULL,
  steps JSON NOT NULL,
  source ENUM('system','manual') NOT NULL DEFAULT 'manual',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_recipe_plan (source, meal, kcal),
  KEY idx_recipe_name (name)
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS recipe_ingredients (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  recipe_id INT UNSIGNED NOT NULL,
  food_id BIGINT UNSIGNED NULL,
  name VARCHAR(160) NOT NULL,
  amount_g DECIMAL(10,2) NOT NULL DEFAULT 0,
  kcal DECIMAL(10,2) NOT NULL DEFAULT 0,
  carbs DECIMAL(10,2) NOT NULL DEFAULT 0,
  protein DECIMAL(10,2) NOT NULL DEFAULT 0,
  fat DECIMAL(10,2) NOT NULL DEFAULT 0,
  category VARCHAR(60) NOT NULL DEFAULT 'Sonstiges',
  KEY idx_recipe_ingredient (recipe_id),
  CONSTRAINT fk_recipe_ingredient_recipe FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
  CONSTRAINT fk_recipe_ingredient_food FOREIGN KEY (food_id) REFERENCES foods(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE IF NOT EXISTS banks (
  blz VARCHAR(12) NOT NULL,
  name VARCHAR(160) NOT NULL,
  bic VARCHAR(16) NULL,
  fints_url VARCHAR(255) NULL,
  city VARCHAR(120) NULL,
  PRIMARY KEY (blz, name),
  KEY idx_bank_name (name),
  KEY idx_bank_bic (bic)
) ENGINE=InnoDB;

ALTER TABLE dishes
  ADD COLUMN IF NOT EXISTS steps JSON NULL,
  ADD COLUMN IF NOT EXISTS recipe_id INT UNSIGNED NULL,
  ADD COLUMN IF NOT EXISTS scale DECIMAL(6,3) NOT NULL DEFAULT 1;

ALTER TABLE dishes MODIFY source ENUM('gemini','manual','system') NOT NULL DEFAULT 'manual';
CREATE INDEX IF NOT EXISTS idx_dishes_recipe ON dishes(recipe_id);
