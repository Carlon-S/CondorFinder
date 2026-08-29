import os
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pwdlib import PasswordHash
from pydantic import BaseModel
from pymongo import AsyncMongoClient
from pymongo.asynchronous.database import AsyncDatabase

# =============================================================================
# CONDORFINDER — AUTENTICACIÓN
# Archivo: backendModel/auth.py
#
# Base de login: un solo usuario "admin" sembrado al arrancar (ver
# seed_admin_user), sesión vía JWT en cookie httpOnly. No hay registro de
# usuarios ni roles todavía — eso es escalado futuro, ver CLAUDE.md.
#
# El cliente de Mongo se crea en el lifespan de orquestador.py y se inyecta
# aquí vía set_db(), en vez de que este módulo abra su propia conexión — un
# solo cliente para todo el proceso.
# =============================================================================

COOKIE_NAME = "access_token"
JWT_ALGORITHM = "HS256"

password_hash = PasswordHash.recommended()

_db: AsyncDatabase | None = None


def set_db(db: AsyncDatabase) -> None:
    global _db
    _db = db


def get_db() -> AsyncDatabase:
    if _db is None:
        raise RuntimeError("La base de datos no fue inicializada — set_db() debe llamarse en el lifespan.")
    return _db


# =============================================================================
# MODELOS
#
# Pydantic valida el TIPO de cada campo antes de que el valor llegue a tocar
# una query de Mongo — un payload tipo {"username": {"$ne": null}} se
# rechaza aquí con 422 porque {"$ne": null} no es un str, nunca llega a
# construirse como filtro de búsqueda. Esto es lo que efectivamente bloquea
# la inyección estilo NoSQL en este endpoint, no una sanitización aparte.
# =============================================================================

class LoginRequest(BaseModel):
    username: str
    password: str


class UserOut(BaseModel):
    username: str


# =============================================================================
# CONTRASEÑAS
# =============================================================================

def hash_password(plain: str) -> str:
    return password_hash.hash(plain)


def verify_password(plain: str, hashed: str) -> bool:
    return password_hash.verify(plain, hashed)


# =============================================================================
# JWT
# =============================================================================

def _jwt_secret() -> str:
    secret = os.environ.get("JWT_SECRET")
    if not secret:
        raise RuntimeError("JWT_SECRET no está seteado en el entorno (ver .env.example).")
    return secret


def _jwt_expire_minutes() -> int:
    return int(os.environ.get("JWT_EXPIRE_MINUTES", "480"))


def create_access_token(username: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=_jwt_expire_minutes())
    payload = {"sub": username, "exp": expire}
    return jwt.encode(payload, _jwt_secret(), algorithm=JWT_ALGORITHM)


def decode_access_token(token: str) -> str:
    """Devuelve el username (claim "sub") o lanza jwt.PyJWTError si el token
    es inválido/expiró — el caller (get_current_user) traduce eso a 401."""
    payload = jwt.decode(token, _jwt_secret(), algorithms=[JWT_ALGORITHM])
    return payload["sub"]


# =============================================================================
# DEPENDENCY: usuario actual a partir de la cookie
# =============================================================================

async def get_current_user(request: Request) -> UserOut:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status_code=401, detail="No autenticado")

    try:
        username = decode_access_token(token)
    except jwt.PyJWTError:
        raise HTTPException(status_code=401, detail="Sesión inválida o expirada")

    # Query como diccionario tipado, nunca por concatenación de strings.
    user = await get_db().users.find_one({"username": username})
    if not user:
        raise HTTPException(status_code=401, detail="Usuario no encontrado")

    return UserOut(username=user["username"])


# =============================================================================
# SEED: usuario admin único, para pruebas
# =============================================================================

async def seed_admin_user(db: AsyncDatabase) -> None:
    admin_username = os.environ.get("SEED_ADMIN_USERNAME")
    admin_password = os.environ.get("SEED_ADMIN_PASSWORD")

    if not admin_username or not admin_password:
        print("[auth] SEED_ADMIN_USERNAME/SEED_ADMIN_PASSWORD no seteados — no se siembra ningún usuario.")
        return

    existing = await db.users.find_one({"username": admin_username})
    if existing:
        return

    await db.users.insert_one({
        "username": admin_username,
        "password_hash": hash_password(admin_password),
        "created_at": datetime.now(timezone.utc),
    })
    print(f"[auth] Usuario admin '{admin_username}' sembrado.")


# =============================================================================
# ENDPOINTS
# =============================================================================

router = APIRouter(prefix="/auth", tags=["auth"])


# COOKIE_SECURE=true en el .env de la VM (nunca en local): el frontend
# desplegado en Cloudflare Workers no pasa por el proxy same-origin del
# dev server de Vite, así que estos fetches son cross-origin de verdad —
# necesitan secure=True + samesite="none" para que el navegador reenvíe la
# cookie. En local (sin la variable), sigue en secure=False + samesite=
# "lax": ahí todo sigue siendo same-origin vía el proxy, y secure=True
# rompería el login porque el backend local es HTTP plano (los navegadores
# descartan cookies Secure seteadas fuera de una conexión HTTPS).
_COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "false").lower() == "true"
_COOKIE_SAMESITE = "none" if _COOKIE_SECURE else "lax"
# COOKIE_DOMAIN (ej. ".condorfinder.cl"): sin esto, la cookie queda scoped
# exactamente al host que la setea (api.condorfinder.cl) y el navegador
# nunca la manda en un request a condorfinder.cl (dominio hermano, no el
# mismo host) — el login "funcionaba" pero el redirect a "/" nunca veía
# sesión. None por defecto (no seteás esto en local): ahí no hace falta,
# es el mismo host vía el proxy de Vite.
_COOKIE_DOMAIN = os.environ.get("COOKIE_DOMAIN")


def _set_auth_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        httponly=True,
        secure=_COOKIE_SECURE,
        samesite=_COOKIE_SAMESITE,
        domain=_COOKIE_DOMAIN,
        path="/",
        max_age=_jwt_expire_minutes() * 60,
    )


@router.post("/login", response_model=UserOut)
async def login(credentials: LoginRequest, response: Response):
    user = await get_db().users.find_one({"username": credentials.username})
    if not user or not verify_password(credentials.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Usuario o contraseña incorrectos")

    token = create_access_token(user["username"])
    _set_auth_cookie(response, token)
    return UserOut(username=user["username"])


@router.post("/logout")
async def logout(response: Response):
    # Debe llevar los mismos atributos con los que se seteó (path/samesite/
    # secure), si no el browser no la reconoce como la misma cookie y no la
    # borra -- delete_cookie() default secure=False, que no calzaba con el
    # secure=True de _set_auth_cookie en producción.
    response.delete_cookie(
        key=COOKIE_NAME, path="/", samesite=_COOKIE_SAMESITE, domain=_COOKIE_DOMAIN, secure=_COOKIE_SECURE
    )
    return {"message": "Sesión cerrada"}


@router.get("/me", response_model=UserOut)
async def me(current_user: UserOut = Depends(get_current_user)):
    return current_user
