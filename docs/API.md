# Spécification et Référence de l'API

Ce document décrit de manière exhaustive l'ensemble des routes HTTP exposées par l'application Next.js et la fonction Lambda `download-api`. Une spécification machine normalisée est également disponible dans [`docs/openapi.yaml`](./openapi.yaml).

---

## 1. Conventions Générales

### 1.1 Formats et Encodage
- Tous les corps de requête et de réponse sont encodés en **UTF-8** au format `application/json` (sauf téléchargement binaire PDF).
- Les dates sont formatées selon la norme ISO 8601 en UTC (`YYYY-MM-DDTHH:mm:ss.sssZ`).
- Les identifiants (`docId`, `linkId`, `reservationId`, `requestId`) sont non devinables avec une entropie $\ge 128$ bits (UUID v4 ou NanoID base64url).

### 1.2 Format Standard des Erreurs
Toutes les erreurs applicatives retournent un corps JSON uniforme :
```json
{
  "error": {
    "code": "code_erreur_machine",
    "message": "Description lisible en français"
  }
}
```

### 1.3 Codes d'État HTTP Notables
| Code | Signification |
| :--- | :--- |
| `200 OK` | Requête traitée avec succès ; contenu disponible. |
| `201 Created` | Ressource créée avec succès. |
| `202 Accepted` | Réservation acceptée, génération PDF en cours (en-tête `Retry-After` inclus). |
| `400 Bad Request` | Corps JSON invalide ou paramètres non conformes au schéma Zod. |
| `401 Unauthorized` | Absence de cookie de session ou jeton expiré. |
| `403 Forbidden` | Permissions insuffisantes pour la ressource demandée. |
| `404 Not Found` | Document, version ou lien introuvable ou révoqué. |
| `409 Conflict` | Conflit d'écriture simultané (retry avec backoff/jitter requis). |
| `410 Gone` | Lien de téléchargement épuisé (quota d'exemplaires atteint, invariant C1). |
| `429 Too Many Requests` | Dépassement de quota de frappe, abus ou rate-limit de restauration. |

---

## 2. Authentification et Sessions

### `POST /api/session`
Crée une session rédacteur sans mot de passe (environnement simplifié sans vérification e-mail) et dépose un cookie HttpOnly chiffré `session`.
- **En-têtes requis** : `Content-Type: application/json`, `Origin: <domaine>`
- **Corps de requête** :
  ```json
  {
    "name": "Alice Martin",
    "email": "alice@asso.fr"
  }
  ```
- **Réponse 200** :
  ```json
  {
    "writer": {
      "writerId": "8ebc0d4900327e376558f8ab5f1a40c0b1d0b5bd7acb4cda00e30956e7ba5c90",
      "name": "Alice Martin",
      "email": "alice@asso.fr"
    }
  }
  ```
  *En-tête de réponse* : `Set-Cookie: session=eyJhbGci...; Path=/; HttpOnly; SameSite=Lax`

### `GET /api/session`
Retourne le profil du rédacteur connecté et son solde journalier de crédit UTF-16.
- **Réponse 200** :
  ```json
  {
    "writer": {
      "writerId": "8ebc0d490032...",
      "name": "Alice Martin",
      "email": "alice@asso.fr"
    },
    "credit": {
      "usedChars": 1450,
      "remainingChars": 8550,
      "dailyQuota": 10000,
      "isBlocked": false,
      "resetAt": "2026-10-25T00:00:00.000Z"
    }
  }
  ```

### `DELETE /api/session`
Supprime le cookie de session et déconnecte le rédacteur.
- **Réponse 200** : `{ "success": true }`

### `GET /api/session/collab-token`
Émet un jeton éphémère (durée de validité 60 s) pour autoriser la connexion WebSocket sur le serveur Hocuspocus (`/collab`).
- **Réponse 200** :
  ```json
  {
    "token": "eyJhbGciOi...",
    "expiresAt": "2026-10-24T18:35:00.000Z"
  }
  ```

---

## 3. Documents et Droits d'Accès

### `GET /api/documents`
Liste tous les documents dont l'utilisateur authentifié est propriétaire ou invité (`editor` / `viewer`).
- **Réponse 200** :
  ```json
  [
    {
      "docId": "doc-94d9318e-630c-4ae5-9e1c-3dcb54c76948",
      "title": "Procès-verbal d'assemblée générale",
      "ownerId": "8ebc0d490032...",
      "role": "owner",
      "createdAt": "2026-10-24T14:00:00.000Z",
      "updatedAt": "2026-10-24T17:30:00.000Z"
    }
  ]
  ```

### `POST /api/documents`
Crée un nouveau document vide.
- **Corps de requête** :
  ```json
  {
    "title": "Nouveau projet associatif"
  }
  ```
- **Réponse 201** :
  ```json
  {
    "docId": "doc-4f51e06a-a1b2-4c3d-8e9f-123456789abc",
    "title": "Nouveau projet associatif",
    "role": "owner",
    "createdAt": "2026-10-24T18:00:00.000Z"
  }
  ```

### `GET /api/documents/:docId`
Retourne le détail d'un document, la liste de ses collaborateurs et son rôle courant.
- **Réponse 200** :
  ```json
  {
    "docId": "doc-4f51e06a...",
    "title": "Nouveau projet associatif",
    "ownerId": "8ebc0d490032...",
    "role": "owner",
    "permissions": [
      { "writerId": "f99aa9e4fa38...", "name": "Bob", "email": "bob@asso.fr", "role": "editor" },
      { "writerId": "c776fd0c266a...", "name": "Charlie", "email": "charlie@asso.fr", "role": "viewer" }
    ]
  }
  ```

### `DELETE /api/documents/:docId`
Supprime un document (action strictement réservée au propriétaire `owner`).
- **Réponse 200** : `{ "success": true }`

### `POST /api/documents/:docId/share`
Ajoute ou modifie le rôle d'un collaborateur (réservé au propriétaire).
- **Corps de requête** :
  ```json
  {
    "targetEmail": "bob@asso.fr",
    "role": "editor"
  }
  ```
- **Réponse 200** : `{ "success": true, "docId": "...", "targetEmail": "bob@asso.fr", "role": "editor" }`

### `DELETE /api/documents/:docId/share/:writerId`
Révoque les droits d'un collaborateur sur le document.
- **Réponse 200** : `{ "success": true }`

---

## 4. Liens et Téléchargements Publics (C1 & C3)

### `POST /api/documents/:docId/links`
Crée un lien de diffusion public avec quota maximal d'exemplaires (`maxDownloads`).
- **Corps de requête** :
  ```json
  {
    "maxDownloads": 50
  }
  ```
- **Réponse 201** :
  ```json
  {
    "linkId": "03vyUn6EKTwHPxh1LlA1mQ",
    "docId": "doc-94d9318e...",
    "maxDownloads": 50,
    "issued": 0,
    "status": "active",
    "url": "http://localhost:3000/d/03vyUn6EKTwHPxh1LlA1mQ"
  }
  ```

### `GET /api/dl/:linkId/status`
Chemin rapide de consultation de l'état d'un lien (ne consomme aucune écriture DynamoDB).
- **Réponse 200 (Disponible)** :
  ```json
  {
    "state": "available",
    "remaining": 12,
    "total": 50
  }
  ```
  *En-tête* : `Cache-Control: no-store`
- **Réponse 200 (Épuisé)** :
  ```json
  {
    "state": "exhausted"
  }
  ```
  *En-tête* : `Cache-Control: public, max-age=1`

### `POST /api/dl/:linkId/request`
Demande atomique de téléchargement d'un exemplaire (C1).
- **Corps de requête** :
  ```json
  {
    "requestId": "9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d"
  }
  ```
- **Réponse 200 (Immédiat - PDF déjà rendu)** :
  ```json
  {
    "state": "issued",
    "downloadUrl": "https://bucket.s3.amazonaws.com/pdfs/.../doc.pdf?AWSAccessKeyId=..."
  }
  ```
- **Réponse 202 (Différé - Rendu PDF en cours)** :
  ```json
  {
    "state": "preparing",
    "reservationId": "res-550e8400-e29b-41d4-a716-446655440000"
  }
  ```
  *En-tête* : `Retry-After: 2`
- **Réponse 410 (Épuisé)** :
  ```json
  {
    "state": "exhausted"
  }
  ```

### `GET /api/dl/:linkId/reservations/:reservationId`
Polling de récupération de l'URL pré-signée pour un exemplaire préalablement réservé.
- **Réponse 200 (Prêt)** :
  ```json
  {
    "state": "issued",
    "downloadUrl": "https://bucket.s3.amazonaws.com/pdfs/.../doc.pdf?AWSAccessKeyId=..."
  }
  ```
- **Réponse 202 (En cours)** :
  ```json
  {
    "state": "preparing"
  }
  ```
  *En-tête* : `Retry-After: 2`

---

## 5. Historique et Restauration (F10)

### `GET /api/documents/:docId/versions`
Liste les versions figées (snapshots S3) d'un document.
- **Réponse 200** :
  ```json
  [
    {
      "snapshotId": "snap-1729792800000",
      "versionId": "4d81464dc278916986e4df76fb1f60346de60c96c981acb9815fbfec244aaf0f",
      "createdAt": "2026-10-24T18:00:00.000Z",
      "charCount": 3420,
      "preview": "Début du texte du procès-verbal..."
    }
  ]
  ```

### `POST /api/documents/:docId/versions/:versionId/restore`
Restaure le document à l'état de la version sélectionnée.
- **Règles métier** :
  - Seuls les rôles `owner` et `editor` peuvent déclencher une restauration.
  - La restauration crée une nouvelle évolution sans altérer les snapshots postérieurs (I08).
  - La restauration n'impute **aucun crédit** au rédacteur (`billedChars = 0`).
  - Limite de taux : 10 restaurations maximum par heure par rédacteur.
- **Réponse 200** :
  ```json
  {
    "success": true,
    "docId": "doc-94d9318e...",
    "restoredVersionId": "4d81464d...",
    "charCount": 3420
  }
  ```
- **Réponse 429** :
  ```json
  {
    "error": {
      "code": "restore_rate_limit",
      "message": "Limite de 10 restaurations par heure atteinte pour ce rédacteur."
    }
  }
  ```

---

## 6. Administration et Supervision (F05 & F11)

### `GET /api/admin/overview`
Retourne la vue globale pour la page d'administration `/admin` (rafraîchissement automatique toutes les 5 s).
- **Authentification** : En-tête `x-admin-token: <ADMIN_TOKEN>`
- **Réponse 200** :
  ```json
  {
    "openDocuments": [
      { "docId": "doc-1", "title": "Doc 1", "activeWriters": 3 }
    ],
    "activeLinks": [
      { "linkId": "03vy...", "docId": "doc-1", "issued": 48, "maxDownloads": 50, "status": "active" }
    ],
    "blockedWriters": [
      {
        "writerId": "bad-actor-id",
        "email": "attaquant@evil.com",
        "blockedUntil": "2026-10-24T18:45:00.000Z",
        "reason": "burst_rate_exceeded"
      }
    ]
  }
  ```

### `POST /api/admin/unblock`
Débloque immédiatement un rédacteur suspendu.
- **Authentification** : En-tête `x-admin-token: <ADMIN_TOKEN>`
- **Corps de requête** :
  ```json
  {
    "writerId": "bad-actor-id"
  }
  ```
- **Réponse 200** : `{ "success": true, "unblocked": "bad-actor-id" }`
