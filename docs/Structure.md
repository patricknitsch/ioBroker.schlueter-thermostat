# schlueter-thermostat Adapter – Program Structure Documentation

## High-Level Architecture

```mermaid
flowchart TB
  U[User / UI / Scripts] -->|write states| IO[(ioBroker States DB)]
  IO -->|stateChange events| ADP[schlueter-thermostat Adapter]

  ADP -->|HTTPS REST (read)| OWD5[OWD5 Cloud API (Read)]
  ADP -->|HTTPS REST (write)| OCD5[OCD5 Cloud API (Write)]
  OCD5 --> TH[Schlüter / OJ Thermostat]
  OWD5 --> ADP
```

## Runtime Lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant I as ioBroker
  participant A as Adapter
  participant R as OWD5 (READ)
  participant W as OCD5 (WRITE)

  I->>A: onReady()
  A->>W: login()
  alt login ok
    A->>I: info.connection = true
    A->>A: pollOnce()
    A->>R: getGroupContents()
    R-->>A: groups + thermostats
    A->>I: update states
    loop polling
      A->>R: getGroupContents()
      R-->>A: new data
      A->>I: update states
    end
  else login fail
    A->>I: info.connection = false
  end
```

## Object Tree

```mermaid
flowchart LR
  ROOT[schlueter-thermostat.0] --> GR[groups]
  GR --> GID[<GroupId>]
  GID --> THS[thermostats]
  THS --> TID[<ThermostatId>]
  TID --> READ[Read-only states]
  TID --> APPLY[apply.* controls]
```

## Apply Flow

```mermaid
flowchart TB
  BTN[apply.<mode>.apply] --> EVT[onStateChange()]
  EVT --> ROUTE[applyRouter()]
  ROUTE --> API[updateThermostat()]
  API --> TH[Cloud → Thermostat]
```

## Apply Modes

```mermaid
flowchart LR
  SCHEDULE -->|Mode 1| API1
  COMFORT -->|Mode 2 + EndTime| API2
  MANUAL -->|Mode 3| API3
  BOOST -->|Mode 8| API4
  ECO -->|Mode 9| API5
  VACATION -->|Vacation fields| API6
```

## Time Handling

```mermaid
flowchart TB
  TZ[Thermostat TimeZone] --> IN[Incoming conversion]
  TZ --> OUT[Outgoing EndTime calculation]
```
