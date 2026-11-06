#!/bin/bash

# AtlasEngine Database Initialization Script
# This script creates the database and applies the schema

set -e  # Exit on error

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  AtlasEngine Database Initialization          ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""

# Load environment variables if .env exists
if [ -f ../.env ]; then
    echo -e "${GREEN}✓${NC} Loading environment variables from .env"
    export $(cat ../.env | grep -v '^#' | xargs)
else
    echo -e "${YELLOW}⚠${NC}  .env file not found, using defaults"
fi

# Database configuration
DB_NAME=${DB_NAME:-atlasengine}
DB_USER=${DB_USER:-atlasengine}
DB_PASSWORD=${DB_PASSWORD:-atlasengine}
DB_HOST=${DB_HOST:-localhost}
DB_PORT=${DB_PORT:-5432}

echo ""
echo "Database Configuration:"
echo "  Host: $DB_HOST:$DB_PORT"
echo "  Database: $DB_NAME"
echo "  User: $DB_USER"
echo ""

# Check if PostgreSQL is running
echo -e "${GREEN}→${NC} Checking PostgreSQL connection..."
if ! pg_isready -h $DB_HOST -p $DB_PORT > /dev/null 2>&1; then
    echo -e "${RED}✗${NC} PostgreSQL is not running on $DB_HOST:$DB_PORT"
    echo ""
    echo "Please start PostgreSQL first:"
    echo "  macOS: brew services start postgresql"
    echo "  Linux: sudo systemctl start postgresql"
    echo "  Docker: docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=postgres postgres:15"
    exit 1
fi
echo -e "${GREEN}✓${NC} PostgreSQL is running"

# Check if database exists
echo -e "${GREEN}→${NC} Checking if database exists..."
if psql -h $DB_HOST -p $DB_PORT -U postgres -lqt | cut -d \| -f 1 | grep -qw $DB_NAME; then
    echo -e "${YELLOW}⚠${NC}  Database '$DB_NAME' already exists"
    read -p "Do you want to DROP and recreate it? (yes/no): " -r
    echo
    if [[ $REPLY =~ ^[Yy]es$ ]]; then
        echo -e "${YELLOW}→${NC} Dropping database..."
        psql -h $DB_HOST -p $DB_PORT -U postgres -c "DROP DATABASE IF EXISTS $DB_NAME;" > /dev/null 2>&1
        echo -e "${GREEN}✓${NC} Database dropped"
    else
        echo -e "${YELLOW}⚠${NC}  Skipping database creation"
        echo ""
        echo "To apply schema to existing database, run:"
        echo "  psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f schema.sql"
        exit 0
    fi
fi

# Create database
echo -e "${GREEN}→${NC} Creating database..."
psql -h $DB_HOST -p $DB_PORT -U postgres -c "CREATE DATABASE $DB_NAME;" > /dev/null 2>&1
echo -e "${GREEN}✓${NC} Database created"

# Create user if not exists
echo -e "${GREEN}→${NC} Creating database user..."
psql -h $DB_HOST -p $DB_PORT -U postgres -c "CREATE USER $DB_USER WITH PASSWORD '$DB_PASSWORD';" > /dev/null 2>&1 || echo -e "${YELLOW}⚠${NC}  User already exists"

# Grant privileges
echo -e "${GREEN}→${NC} Granting privileges..."
psql -h $DB_HOST -p $DB_PORT -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE $DB_NAME TO $DB_USER;" > /dev/null 2>&1
echo -e "${GREEN}✓${NC} Privileges granted"

# Apply schema
echo -e "${GREEN}→${NC} Applying database schema..."
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -f schema.sql

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓${NC} Schema applied successfully"
else
    echo -e "${RED}✗${NC} Failed to apply schema"
    exit 1
fi

# Verify tables
echo ""
echo -e "${GREEN}→${NC} Verifying tables..."
TABLE_COUNT=$(PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -t -c "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';")
echo -e "${GREEN}✓${NC} Created $TABLE_COUNT tables"

# List tables
echo ""
echo "Tables created:"
PGPASSWORD=$DB_PASSWORD psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME -c "\dt"

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║  Database initialization complete! ✓           ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════╝${NC}"
echo ""
echo "Connection string:"
echo "  postgresql://$DB_USER:$DB_PASSWORD@$DB_HOST:$DB_PORT/$DB_NAME"
echo ""
echo "To connect:"
echo "  psql -h $DB_HOST -p $DB_PORT -U $DB_USER -d $DB_NAME"
echo ""
