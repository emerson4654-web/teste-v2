-- EB Manager: TextLabel do CDP + registro de treinamentos a partir de scripts SERVER.
-- Coloque este Script em ServerScriptService. Nunca mova a chave para um LocalScript.
-- Ative Game Settings > Security > Allow HTTP Requests.

local Players = game:GetService("Players")
local HttpService = game:GetService("HttpService")
local ServerScriptService = game:GetService("ServerScriptService")

-- Substitua pela URL HTTPS real do Web Service do Render (sem barra final).
local EB_MANAGER_URL = "https://SEU-SERVICO.onrender.com"
-- Mesma chave em ROBLOX_CDP_API_KEY do Render. Guarde somente em Script de servidor.
local CDP_API_KEY = "COLOQUE_A_MESMA_CHAVE_SECRETA_DO_RENDER_AQUI"
local REFRESH_SECONDS = 60
local GUI_NAME = "EB_CDP_GUI"

local function createLabel(player)
    local playerGui = player:WaitForChild("PlayerGui", 20)
    if not playerGui then return nil end

    local existing = playerGui:FindFirstChild(GUI_NAME)
    if existing then existing:Destroy() end

    local screenGui = Instance.new("ScreenGui")
    screenGui.Name = GUI_NAME
    screenGui.ResetOnSpawn = false
    screenGui.IgnoreGuiInset = false
    screenGui.DisplayOrder = 20
    screenGui.Parent = playerGui

    local label = Instance.new("TextLabel")
    label.Name = "CDPLabel"
    label.AnchorPoint = Vector2.new(0.5, 0)
    label.Position = UDim2.new(0.5, 0, 0, 12)
    label.Size = UDim2.new(0, 300, 0, 42)
    label.BackgroundColor3 = Color3.fromRGB(35, 7, 87)
    label.BackgroundTransparency = 0.08
    label.BorderSizePixel = 0
    label.Text = "CDP: consultando..."
    label.TextColor3 = Color3.fromRGB(255, 230, 105)
    label.TextScaled = true
    label.Font = Enum.Font.GothamBold
    label.TextWrapped = true
    label.Parent = screenGui

    local corner = Instance.new("UICorner")
    corner.CornerRadius = UDim.new(0, 10)
    corner.Parent = label
    local stroke = Instance.new("UIStroke")
    stroke.Color = Color3.fromRGB(255, 218, 65)
    stroke.Thickness = 1.5
    stroke.Parent = label
    local padding = Instance.new("UIPadding")
    padding.PaddingLeft = UDim.new(0, 8)
    padding.PaddingRight = UDim.new(0, 8)
    padding.Parent = label
    return label
end

local function configured()
    return not EB_MANAGER_URL:find("SEU%-SERVICO") and not CDP_API_KEY:find("COLOQUE_A_MESMA")
end

local function apiRequest(path, method, body)
    local params = {
        Url = EB_MANAGER_URL .. path,
        Method = method,
        Headers = {
            ["x-cdp-api-key"] = CDP_API_KEY,
            ["accept"] = "application/json",
            ["content-type"] = "application/json",
        },
    }
    if body then params.Body = HttpService:JSONEncode(body) end
    return HttpService:RequestAsync(params)
end

local function fetchCdp(player, label)
    if not player.Parent or not label.Parent then return end
    if not configured() then label.Text = "CDP: configure a API do EB Manager"; return end
    local success, response = pcall(function()
        return apiRequest("/api/roblox/cdp?userId=" .. tostring(player.UserId), "GET")
    end)
    if not success then label.Text = "CDP: servidor indisponível"; warn("EB Manager CDP HTTP: " .. tostring(response)); return end
    if not response.Success then label.Text = "CDP: erro " .. tostring(response.StatusCode); warn("EB Manager CDP status " .. tostring(response.StatusCode)); return end
    local decodedSuccess, data = pcall(function() return HttpService:JSONDecode(response.Body) end)
    if not decodedSuccess or type(data) ~= "table" or type(data.cdp) ~= "table" then label.Text = "CDP: resposta inválida"; return end
    label.Text = tostring(data.cdp.displayText or "CDP: sem dados")
    label.TextColor3 = data.cdp.inCdp and Color3.fromRGB(255, 155, 155) or Color3.fromRGB(255, 230, 105)
end

local function onPlayerAdded(player)
    task.spawn(function()
        local label = createLabel(player)
        if not label then return end
        task.wait(player.UserId % 12)
        while player.Parent and label.Parent do
            fetchCdp(player, label)
            task.wait(REFRESH_SECONDS)
        end
    end)
end
Players.PlayerAdded:Connect(onPlayerAdded)
for _, player in ipairs(Players:GetPlayers()) do onPlayerAdded(player) end

-- Integração opcional com os seus scripts de treinamento, somente no servidor.
-- Um script confiável pode chamar:
-- ServerScriptService.EBRegistrarTreinamento:Fire(player, "Treinamento Básico", "Concluiu todas as etapas")
-- Este BindableEvent não é replicado para os clientes. Dispare-o apenas depois de confirmar a conclusão.
local trainingEvent = ServerScriptService:FindFirstChild("EBRegistrarTreinamento")
if not trainingEvent then
    trainingEvent = Instance.new("BindableEvent")
    trainingEvent.Name = "EBRegistrarTreinamento"
    trainingEvent.Parent = ServerScriptService
end
trainingEvent.Event:Connect(function(player, trainingName, observations)
    if typeof(player) ~= "Instance" or not player:IsA("Player") or player.Parent ~= Players then
        warn("EBRegistrarTreinamento recebeu um jogador inválido")
        return
    end
    if not configured() then warn("EB Manager: configure a URL e a chave antes de registrar treinos."); return end
    local payload = {
        userId = player.UserId,
        trainingName = tostring(trainingName or "Treinamento Roblox"),
        observations = tostring(observations or ""),
    }
    task.spawn(function()
        local ok, response = pcall(function() return apiRequest("/api/roblox/trainings", "POST", payload) end)
        if not ok then warn("EB Manager: falha ao registrar treinamento: " .. tostring(response)); return end
        if not response.Success then warn("EB Manager: API de treinamento respondeu HTTP " .. tostring(response.StatusCode) .. ": " .. tostring(response.Body)) end
    end)
end)
