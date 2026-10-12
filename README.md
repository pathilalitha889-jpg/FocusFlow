# FocusFlow — Student Planner with Accounts

A responsive Flask + SQLite full-stack study planner with account registration/login, per-user task isolation, task deadlines, a focus timer, statistics, and a weekly completion chart.

## Features

- Create an account and log in/out
- Passwords are stored as password hashes, not plain text
- Each account sees, creates, updates, and deletes only its own tasks
- Add tasks with category and optional date-and-time deadline
- Get an in-page reminder and synthesized alarm sound 5 minutes before a timed deadline, plus another alert when it is due
- Browser desktop notifications when permission is granted
- Mark tasks complete/pending and delete them
- Filter all, pending, and completed tasks
- Deadline-based priority labels
- Focus timer (25 minutes) and break timer (5 minutes)
- Dashboard totals and weekly completed-task chart
- SQLite persistence and a small migration for the older task database
- Responsive login and dashboard pages

## Requirements

- Python 3.10 or later
- Flask 3.x (installed using `requirements.txt`)

## Run on Windows

Open PowerShell in the folder containing `app.py` and `requirements.txt`:

```powershell
python -m pip install -r requirements.txt
python app.py
```

Then open http://127.0.0.1:5000. Create an account on the first page. Keep the terminal open while using the app.

## Deadline reminders

1. Open FocusFlow in Chrome, Edge, or another modern browser.
2. Click **Enable alerts** and allow notifications if the browser asks. The button plays a short test sound.
3. Add a task and choose both the deadline date and time.
4. Keep the FocusFlow tab open. The app shows an in-page reminder and plays a short alarm about 5 minutes before the deadline, then alerts again when the deadline arrives. Browser notifications also appear if permission was granted.

**Important limitation:** These are browser-side scheduled reminders. The browser tab and Flask server need to remain open for reliable timing. If you close the tab/browser or turn off the computer, reminders cannot run in the background. When the app is reopened, a deadline that passed within the last 2 hours can trigger its due alert. For notifications while the browser is fully closed, this project would need additional service-worker/push infrastructure and deployment over HTTPS. Browser notification permissions and system sound settings must also allow alerts. Existing date-only tasks remain visible but do not have a scheduled alarm until a time is set (create a new timed task for alarms).

## Database and security notes

- `focusflow.db` stores account records and tasks on the machine running Flask.
- Passwords are hashed with Werkzeug's password-hashing helpers.
- A local `.flask_secret` file is generated to sign the login session. It is excluded from Git.
- For internet deployment, set a strong `FLASK_SECRET_KEY`, use HTTPS, and set `FLASK_HTTPS_ONLY=1`. Configure your deployment platform's database and backups before using it with real user information.
- This is a student portfolio project; it has not undergone a professional security audit.

## API endpoints

Authenticated JSON endpoints:
- `GET /api/tasks` — list only the signed-in user's tasks
- `POST /api/tasks` — create a task (`title`, `category`, `deadline`)
- `PATCH /api/tasks/<id>` — update completion (`completed: true/false`)
- `DELETE /api/tasks/<id>` — delete a task
- `GET /api/stats` — signed-in user's task totals and completed-date counts

Account pages: `/register`, `/login`; sign out from the dashboard.
