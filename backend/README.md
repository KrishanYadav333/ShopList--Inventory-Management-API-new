# ShopList Backend API

RESTful API for inventory management built with Node.js, Express, and PostgreSQL.

## Features

- **Product Management**: CRUD operations for products
- **Search & Filtering**: Search products by name or SKU
- **Pagination**: Efficient data loading with pagination
- **Mock Mode**: Runs without database for development
- **Error Handling**: Comprehensive error handling and validation
- **CORS Support**: Cross-origin resource sharing enabled

## Tech Stack

- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **PostgreSQL** - Primary database
- **pg** - PostgreSQL client
- **dotenv** - Environment configuration
- **CORS** - Cross-origin resource sharing

## Project Structure

```
backend/
├── src/
│   ├── config/           # Configuration files
│   │   └── env.js       # Environment variables
│   ├── controllers/     # Route controllers
│   │   └── product.controller.js
│   ├── db/             # Database layer
│   │   ├── migrations/ # SQL migration files
│   │   ├── migrate.js  # Migration runner
│   │   └── pool.js     # Database connection pool
│   ├── middlewares/    # Express middlewares
│   │   ├── auth.js     # Authentication middleware
│   │   └── error.js    # Error handling middleware
│   ├── repos/          # Data access layer
│   │   └── product.repo.js
│   ├── routes/         # API routes
│   │   └── products.routes.js
│   ├── services/       # Business logic layer
│   │   └── product.service.js
│   ├── utils/          # Utility functions
│   │   └── pagination.js
│   └── server.js       # Main application entry point
├── .env               # Environment variables
├── package.json       # Dependencies and scripts
└── README.md         # This file
```

## Quick Start

### Prerequisites
- Node.js (v18 or higher)
- PostgreSQL (v12 or higher) - Optional for development
- npm or yarn

### Installation

1. **Install dependencies**
   ```bash
   npm install
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your settings:
   ```
   PORT=8080
   DATABASE_URL=postgres://user:password@localhost:5432/shoplist
   BASIC_AUTH_USER=admin
   BASIC_AUTH_PASS=secret
   ```

3. **Run database migrations** (if using PostgreSQL)
   ```bash
   npm run db:migrate
   ```

4. **Start the server**
   ```bash
   # Development mode
   npm run dev
   
   # Production mode
   npm start
   ```

## API Endpoints

### Products

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/products` | Get all products with pagination |
| GET | `/api/products/:id` | Get product by ID |
| POST | `/api/products` | Create new product |
| PUT | `/api/products/:id` | Update product |
| DELETE | `/api/products/:id` | Delete product |

### Health Check

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | API health status |

### Query Parameters

**GET /api/products**
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 10, max: 100)
- `search` - Search by name or SKU

### Request/Response Examples

**Create Product**
```bash
POST /api/products
Content-Type: application/json

{
  "name": "Laptop Computer",
  "description": "High-performance laptop",
  "price": 999.99,
  "quantity": 50,
  "sku": "LAP-001"
}
```

**Response**
```json
{
  "id": 1,
  "name": "Laptop Computer",
  "description": "High-performance laptop",
  "price": 999.99,
  "quantity": 50,
  "sku": "LAP-001",
  "created_at": "2024-01-01T00:00:00.000Z",
  "updated_at": "2024-01-01T00:00:00.000Z"
}
```

## Database Schema

```sql
CREATE TABLE products (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    description TEXT,
    price DECIMAL(10,2) NOT NULL CHECK (price >= 0),
    quantity INTEGER NOT NULL CHECK (quantity >= 0),
    sku VARCHAR(50) UNIQUE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

## Development

### Available Scripts

- `npm start` - Start production server
- `npm run dev` - Start development server with auto-reload
- `npm run db:migrate` - Run database migrations
- `npm test` - Run tests (placeholder)

### Mock Mode

The API can run without a database connection using in-memory mock data. This is useful for:
- Development without PostgreSQL setup
- Testing and demonstrations
- CI/CD environments

Mock mode is automatically enabled when:
- No `DATABASE_URL` is provided
- Database connection fails

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `PORT` | Server port | 8080 |
| `DATABASE_URL` | PostgreSQL connection string | - |
| `BASIC_AUTH_USER` | Basic auth username | admin |
| `BASIC_AUTH_PASS` | Basic auth password | secret |
| `NODE_ENV` | Environment mode | development |

## Error Handling

The API uses consistent error responses:

```json
{
  "error": "Error Type",
  "message": "Detailed error message"
}
```

**HTTP Status Codes:**
- `200` - Success
- `201` - Created
- `400` - Bad Request (validation errors)
- `404` - Not Found
- `409` - Conflict (duplicate SKU)
- `500` - Internal Server Error

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details