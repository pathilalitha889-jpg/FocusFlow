from contextlib import contextmanager
from datetime import date, datetime, timedelta
from functools import wraps
import os
from pathlib import Path
import re
import secrets
import sqlite3

from flask import Flask, abort, jsonify, redirect, render_template, request, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
DATABASE = BASE_DIR / "focusflow.db"
SECRET_FILE = BASE_DIR / ".flask_secret"


def load_secret_key():
    """Use an environment secret in deployment, or persist a local dev key."""
    env_key = os.environ.get("FLASK_SECRET_KEY")
    if env_key:
        return env_key
    try:
        if SECRET_FILE.exists():
            existing = SECRET_FILE.read_text(encoding="utf-8").strip()
            if existing:
                return existing
        generated = secrets.token_hex(32)
        SECRET_FILE.write_text(generated, encoding="utf-8")
        return generated
    except OSError:
        # Fallback for read-only project folders; sessions won't persist across restarts.
        return secrets.token_hex(32)


app = Flask(__name__)
app.config.update(
    SECRET_KEY=load_secret_key(),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=os.environ.get("FLASK_HTTPS_ONLY", "0") == "1",
    PERMANENT_SESSION_LIFETIME=timedelta(days=7),
)


@contextmanager
def get_db():
    connection = sqlite3.connect(DATABASE)
    connection.row_factory = sqlite3.Row
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def csrf_token():
    token = session.get("_csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["_csrf_token"] = token
    return token


def valid_csrf():
    supplied = request.form.get("csrf_token", "")
    expected = session.get("_csrf_token", "")
    return bool(supplied and expected and secrets.compare_digest(supplied, expected))


app.jinja_env.globals["csrf_token"] = csrf_token


def initialize_db():
    with get_db() as db:
        db.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                email TEXT NOT NULL UNIQUE COLLATE NOCASE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        db.execute("""
            CREATE TABLE IF NOT EXISTS tasks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER REFERENCES users(id),
                title TEXT NOT NULL,
                category TEXT NOT NULL DEFAULT 'Study',
                deadline TEXT NOT NULL DEFAULT '',
                completed INTEGER NOT NULL DEFAULT 0,
                completed_date TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        """)
        # Migrate a database created by the original no-login version.
        columns = {row["name"] for row in db.execute("PRAGMA table_info(tasks)").fetchall()}
        if "user_id" not in columns:
            db.execute("ALTER TABLE tasks ADD COLUMN user_id INTEGER")
        db.commit()


def task_to_dict(row):
    task = dict(row)
    task["completed"] = bool(task["completed"])
    return task


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("user_id"):
            if request.path.startswith("/api/"):
                return jsonify({"error": "Please log in to continue."}), 401
            return redirect(url_for("login"))
        return view(*args, **kwargs)
    return wrapped


def render_auth(mode, error=None, status=200):
    return render_template("auth.html", mode=mode, error=error), status


@app.route("/")
@login_required
def index():
    return render_template(
        "index.html",
        username=session.get("user_name", "Student"),
        user_id=session["user_id"],
    )


@app.route("/register", methods=["GET", "POST"])
def register():
    if session.get("user_id"):
        return redirect(url_for("index"))
    if request.method == "GET":
        return render_auth("register")
    if not valid_csrf():
        return render_auth("register", "This form expired. Refresh the page and try again.", 400)

    name = request.form.get("name", "").strip()
    email = request.form.get("email", "").strip().lower()
    password = request.form.get("password", "")
    confirm_password = request.form.get("confirm_password", "")

    if len(name) < 2 or len(name) > 50:
        return render_auth("register", "Name must be between 2 and 50 characters.", 400)
    if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", email) or len(email) > 254:
        return render_auth("register", "Enter a valid email address.", 400)
    if len(password) < 8:
        return render_auth("register", "Password must contain at least 8 characters.", 400)
    if len(password) > 128:
        return render_auth("register", "Password must be 128 characters or fewer.", 400)
    if password != confirm_password:
        return render_auth("register", "Passwords do not match.", 400)

    try:
        with get_db() as db:
            existing_users = db.execute("SELECT COUNT(*) FROM users").fetchone()[0]
            cursor = db.execute(
                "INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)",
                (name, email, generate_password_hash(password)),
            )
            user_id = cursor.lastrowid
            # If this is the first account on a database from the old version,
            # attach existing tasks to this account instead of losing them.
            if existing_users == 0:
                db.execute("UPDATE tasks SET user_id = ? WHERE user_id IS NULL", (user_id,))
    except sqlite3.IntegrityError:
        return render_auth("register", "An account with that email already exists.", 409)

    session.clear()
    session.permanent = True
    session["user_id"] = user_id
    session["user_name"] = name
    return redirect(url_for("index"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if session.get("user_id"):
        return redirect(url_for("index"))
    if request.method == "GET":
        return render_auth("login")
    if not valid_csrf():
        return render_auth("login", "This form expired. Refresh the page and try again.", 400)

    email = request.form.get("email", "").strip().lower()
    password = request.form.get("password", "")
    with get_db() as db:
        user = db.execute(
            "SELECT id, name, email, password_hash FROM users WHERE email = ?",
            (email,),
        ).fetchone()

    if user is None or not check_password_hash(user["password_hash"], password):
        return render_auth("login", "Email or password is incorrect.", 401)

    session.clear()
    session.permanent = True
    session["user_id"] = user["id"]
    session["user_name"] = user["name"]
    return redirect(url_for("index"))


@app.post("/logout")
@login_required
def logout():
    if not valid_csrf():
        abort(400, "Invalid form token. Refresh the page and try again.")
    session.clear()
    return redirect(url_for("login"))


@app.get("/api/tasks")
@login_required
def get_tasks():
    with get_db() as db:
        rows = db.execute("""
            SELECT id, title, category, deadline, completed,
                   completed_date, created_at
            FROM tasks
            WHERE user_id = ?
            ORDER BY completed ASC, id DESC
        """, (session["user_id"],)).fetchall()
    return jsonify([task_to_dict(row) for row in rows])


@app.post("/api/tasks")
@login_required
def create_task():
    data = request.get_json(silent=True) or {}
    title = str(data.get("title", "")).strip()
    category = str(data.get("category", "Study")).strip()
    deadline = str(data.get("deadline", "")).strip()
    allowed_categories = {"Study", "Assignment", "Exam", "Personal"}
    if not title:
        return jsonify({"error": "Please enter a task title."}), 400
    if len(title) > 160:
        return jsonify({"error": "Task title must be 160 characters or fewer."}), 400
    if category not in allowed_categories:
        return jsonify({"error": "Choose a valid category."}), 400
    if deadline:
        try:
            # New tasks use YYYY-MM-DDTHH:MM so reminders can run at a specific time.
            # Date-only values remain accepted for existing databases/tasks.
            if "T" in deadline:
                parsed_deadline = datetime.fromisoformat(deadline)
                if parsed_deadline.tzinfo is not None:
                    raise ValueError("Use a local date and time without a timezone.")
            else:
                date.fromisoformat(deadline)
        except ValueError:
            return jsonify({"error": "Deadline must be a valid date and time."}), 400

    with get_db() as db:
        cursor = db.execute("""
            INSERT INTO tasks (user_id, title, category, deadline)
            VALUES (?, ?, ?, ?)
        """, (session["user_id"], title, category, deadline))
        task_id = cursor.lastrowid
        row = db.execute("""
            SELECT id, title, category, deadline, completed,
                   completed_date, created_at
            FROM tasks WHERE id = ? AND user_id = ?
        """, (task_id, session["user_id"])).fetchone()
    return jsonify(task_to_dict(row)), 201


@app.patch("/api/tasks/<int:task_id>")
@login_required
def update_task(task_id):
    data = request.get_json(silent=True) or {}
    if not isinstance(data.get("completed"), bool):
        return jsonify({"error": "The completed field must be true or false."}), 400
    completed = data["completed"]
    completed_date = date.today().isoformat() if completed else ""
    with get_db() as db:
        cursor = db.execute("""
            UPDATE tasks SET completed = ?, completed_date = ?
            WHERE id = ? AND user_id = ?
        """, (int(completed), completed_date, task_id, session["user_id"]))
        if cursor.rowcount == 0:
            return jsonify({"error": "Task not found."}), 404
        row = db.execute("""
            SELECT id, title, category, deadline, completed,
                   completed_date, created_at
            FROM tasks WHERE id = ? AND user_id = ?
        """, (task_id, session["user_id"])).fetchone()
    return jsonify(task_to_dict(row))


@app.delete("/api/tasks/<int:task_id>")
@login_required
def delete_task(task_id):
    with get_db() as db:
        cursor = db.execute(
            "DELETE FROM tasks WHERE id = ? AND user_id = ?",
            (task_id, session["user_id"]),
        )
    if cursor.rowcount == 0:
        return jsonify({"error": "Task not found."}), 404
    return jsonify({"success": True, "id": task_id})


@app.get("/api/stats")
@login_required
def get_stats():
    user_id = session["user_id"]
    with get_db() as db:
        total = db.execute("SELECT COUNT(*) FROM tasks WHERE user_id = ?", (user_id,)).fetchone()[0]
        completed = db.execute(
            "SELECT COUNT(*) FROM tasks WHERE user_id = ? AND completed = 1", (user_id,)
        ).fetchone()[0]
        rows = db.execute("""
            SELECT completed_date, COUNT(*) AS count
            FROM tasks
            WHERE user_id = ? AND completed = 1 AND completed_date != ''
            GROUP BY completed_date
        """, (user_id,)).fetchall()
    weekly = {row["completed_date"]: row["count"] for row in rows}
    return jsonify({"total": total, "completed": completed, "pending": total - completed, "weekly": weekly})


initialize_db()

if __name__ == "__main__":
    app.run(debug=True)
