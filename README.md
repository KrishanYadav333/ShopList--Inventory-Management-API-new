# ShopList - Full Stack Inventory Management

A modern, full-stack inventory management application built with Node.js, Express, PostgreSQL, and vanilla JavaScript. Features a clean REST API backend and a responsive frontend interface.

## 🚀 Features

### Backend API
- **RESTful API** - Clean, well-documented endpoints
- **Product Management** - Full CRUD operations
- **Search & Filtering** - Real-time search by name or SKU
- **Pagination** - Efficient data loading
- **Mock Mode** - Runs without database for development
- **Error Handling** - Comprehensive validation and error responses
- **CORS Support** - Ready for frontend integration

### Frontend Interface
- **Modern Design** - Clean, professional UI with animations
- **Responsive Layout** - Works on desktop, tablet, and mobile
- **Real-time Search** - Instant product filtering
- **Dashboard Stats** - Quick inventory overview
- **Modal Editing** - Intuitive product management
- **Loading States** - Smooth user experience

## 🛠 Tech Stack

### Backend
- **Node.js** - Runtime environment
- **Express.js** - Web framework
- **PostgreSQL** - Database (optional for development)
- **CORS** - Cross-origin resource sharing

### Frontend
- **Vanilla JavaScript** - No frameworks, pure JS
- **Modern CSS** - Grid, Flexbox, animations
- **Font Awesome** - Professional icons
- **Fetch API** - Modern HTTP client

## 📁 Project Structure

```
shoplist-fullstack/
├── backend/                    # Backend API (Node.js/Express)
│   ├── src/
│   │   ├── config/            # Configuration files
│   │   ├── controllers/       # Route controllers
│   │   ├── db/               # Database setup and migrations
│   │   ├── middlewares/      # Express middlewares
│   │   ├── repos/            # Data access layer
│   │   ├── routes/           # API routes
│   │   ├── services/         # Business logic
│   │   ├── utils/            # Utility functions
│   │   └── server.js         # Main server file
│   ├── .env                  # Environment variables
│   ├── package.json          # Backend dependencies
│   └── README.md            # Backend documentation
├── frontend/                  # Frontend (Vanilla JS/HTML/CSS)
│   ├── assets/
│   │   ├── css/              # Stylesheets
│   │   └── js/               # JavaScript files
│   ├── index.html            # Main HTML file
│   ├── package.json          # Frontend dependencies
│   └── README.md            # Frontend documentation
├── docs/                     # Project documentation
├── package.json              # Root package.json for scripts
└── README.md                # This file
```

## 🚀 Quick Start

### Prerequisites
- **Node.js** (v18 or higher)
- **npm** (v8 or higher)
- **PostgreSQL** (v12 or higher) - Optional for development

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd shoplist-fullstack
   ```

2. **Install all dependencies**
   ```bash
   npm run setup
   ```

3. **Configure environment** (optional)
   ```bash
   cd backend
   cp .env.example .env
   ```
   Edit `backend/.env` with your settings:
   ```
   PORT=8080
   DATABASE_URL=postgres://user:password@localhost:5432/shoplist
   ```

4. **Run database migrations** (if using PostgreSQL)
   ```bash
   npm run backend:migrate
   ```

5. **Start the application**
   ```bash
   # Development mode (both backend and frontend)
   npm run dev
   
   # Or start individually
   npm run backend:dev    # Backend only
   npm run frontend:dev   # Frontend only
   ```

6. **Open your browser**
   - Backend API: `http://localhost:8080/api/health`
   - Frontend: `http://localhost:8080` (served by backend)
   - Frontend Dev Server: `http://localhost:8080` (if running separately)

## 📚 Available Scripts

### Root Level
- `npm run setup` - Install all dependencies and run migrations
- `npm run dev` - Start both backend and frontend in development mode
- `npm run start` - Start both backend and frontend in production mode
- `npm run clean` - Remove all node_modules directories

### Backend
- `npm run backend:dev` - Start backend development server
- `npm run backend:start` - Start backend production server
- `npm run backend:migrate` - Run database migrations
- `npm run backend:install` - Install backend dependencies

### Frontend
- `npm run frontend:dev` - Start frontend development server
- `npm run frontend:start` - Start frontend production server
- `npm run frontend:install` - Install frontend dependencies

## 🔌 API Endpoints

### Products
- `GET /api/products` - Get all products (with pagination and search)
- `GET /api/products/:id` - Get product by ID
- `POST /api/products` - Create new product
- `PUT /api/products/:id` - Update product
- `DELETE /api/products/:id` - Delete product

### Health Check
- `GET /api/health` - API health status

### Query Parameters
- `page` - Page number (default: 1)
- `limit` - Items per page (default: 10, max: 100)
- `search` - Search by name or SKU

## 💾 Database Schema

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

## 🔧 Development Features

### Mock Mode
The application can run without a database connection using in-memory mock data:
- Automatic fallback when database is unavailable
- Sample products for testing
- Full CRUD operations in memory
- Perfect for development and demonstrations

### Hot Reload
- Backend: Automatic restart with nodemon
- Frontend: Live reload with live-server
- Concurrent development with both servers running

### Error Handling
- Comprehensive validation
- Detailed error messages
- Consistent error responses
- Development-friendly error details

## 🌐 Deployment

### Environment Variables
```bash
# Backend
PORT=8080
DATABASE_URL=postgres://user:password@host:port/database
NODE_ENV=production

# Optional
BASIC_AUTH_USER=admin
BASIC_AUTH_PASS=secret
```

### Production Build
```bash
# Install dependencies
npm run install:all

# Run migrations (if using database)
npm run backend:migrate

# Start production servers
npm run start
```

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature-name`
3. Make your changes
4. Test thoroughly
5. Submit a pull request

### Development Guidelines
- Follow existing code style
- Add comments for complex logic
- Test on multiple browsers (frontend)
- Ensure responsive design works
- Update documentation as needed

## 📄 License

MIT License - see LICENSE file for details

## 🆘 Support

### Common Issues

**Port already in use**
```bash
# Change port in backend/.env
PORT=3001
```

**Database connection failed**
- The app will automatically run in mock mode
- Check your DATABASE_URL format
- Ensure PostgreSQL is running

**Frontend not loading**
- Check that backend is serving static files
- Verify asset paths in HTML
- Clear browser cache

### Getting Help
- Check the documentation in `/docs`
- Review the API endpoints
- Look at the example requests/responses
- Create an issue on GitHub

---

**Happy coding! 🚀**
## Live demo (Cloudflare)

https://shoplist.technology1.workers.dev

The Worker in `worker/index.js` serves `frontend/` and the same `/api/products` API as the Express backend, backed by Cloudflare D1 (SQLite). Writes are public and capped at 500 products because it is a demo.

```bash
npx wrangler d1 create shoplist-db        # put the id in wrangler.jsonc
npx wrangler d1 migrations apply shoplist-db --remote
npx wrangler deploy
```

Differences from the Express version: integer ids instead of UUIDs (the front end needs them), and `DELETE` returns `200 {"id": ...}` instead of `204`.
